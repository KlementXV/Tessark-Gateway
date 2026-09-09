// Minimal in-cluster Kubernetes REST client — deliberately not the official
// @kubernetes/client-node package (large dependency, most of it unused here). Follows the
// same "wrap fetch with the right auth" shape as registries/http.ts. Reads the standard
// serviceaccount mount (token/ca.crt/namespace) and the KUBERNETES_SERVICE_HOST/PORT env
// vars Kubernetes injects into every pod automatically — nothing to configure beyond RBAC
// (the pod's ServiceAccount needs create/get/delete on jobs and secrets in its namespace)
// and setting K8S_NAMESPACE if it should differ from the pod's own namespace.
//
// Exercised against a real cluster (k3s v1.36) on 2026-09-04: listing, Job creation and the
// pod-log read below all verified. The Harbor-facing half of a transfer — credentials, image
// refs — is not covered by that, only the Kubernetes half.
import { readFileSync } from "node:fs"
import { Agent } from "undici"
import { getConfig } from "@/lib/config"

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"

// Projected ServiceAccount tokens default to a 1h TTL and are refreshed on disk by the
// kubelet well before they expire — re-reading the file periodically (rather than once, for
// the pod's whole lifetime) is enough to survive rotation without ever needing to know the
// exact expiry. The CA and API server address never change for a running pod, so only the
// token is re-read.
const TOKEN_TTL_MS = 60_000

interface StaticConfig {
  apiServer: string
  namespace: string
  dispatcher: Agent
}

let staticCached: StaticConfig | null = null

function loadStatic(): StaticConfig {
  if (staticCached) return staticCached

  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443"
  if (!host) {
    throw new Error("KUBERNETES_SERVICE_HOST is not set — this must run inside a Kubernetes pod.")
  }

  const ca = readFileSync(`${SA_DIR}/ca.crt`)
  const namespace = getConfig().k8sNamespace ?? readFileSync(`${SA_DIR}/namespace`, "utf8").trim()

  staticCached = {
    apiServer: `https://${host}:${port}`,
    namespace,
    dispatcher: new Agent({ connect: { ca } }),
  }
  return staticCached
}

let tokenCache: { value: string; readAt: number } | null = null

function currentToken(): string {
  const now = Date.now()
  if (tokenCache && now - tokenCache.readAt < TOKEN_TTL_MS) return tokenCache.value
  const value = readFileSync(`${SA_DIR}/token`, "utf8").trim()
  tokenCache = { value, readAt: now }
  return value
}

/**
 * Validates that pulling is either cleanly disabled or properly set up — called at startup
 * (readiness probe) so a missing ServiceAccount mount fails fast and clearly instead of
 * surfacing as a 502 on the first pull. A no-op when K8S_ENABLED=false: nothing to check.
 */
export function assertK8sConfig(): void {
  if (!getConfig().k8sEnabled) return

  const host = process.env.KUBERNETES_SERVICE_HOST
  if (!host) {
    throw new Error(
      "K8S_ENABLED=true but KUBERNETES_SERVICE_HOST is not set — this must run inside a Kubernetes pod, or set K8S_ENABLED=false to disable image pulling.",
    )
  }
  for (const file of ["token", "ca.crt", "namespace"]) {
    try {
      readFileSync(`${SA_DIR}/${file}`)
    } catch {
      throw new Error(
        `K8S_ENABLED=true but ${SA_DIR}/${file} is not readable — is the ServiceAccount token projected into this pod?`,
      )
    }
  }
}

export type K8sHealth =
  | { status: "disabled" }
  | { status: "ok" }
  | { status: "unreachable"; error: string }

// Reusable by /api/ready (lot 8): distinguishes "the feature is off on purpose" from "it's on
// but something's wrong", which call for very different admin reactions.
export async function k8sHealth(): Promise<K8sHealth> {
  if (!getConfig().k8sEnabled) return { status: "disabled" }

  try {
    assertK8sConfig()
    const ns = currentNamespace()
    const res = await k8sFetch(`/api/v1/namespaces/${ns}`)
    if (!res.ok) return { status: "unreachable", error: `Kubernetes API server responded ${res.status}` }
    return { status: "ok" }
  } catch (err) {
    return { status: "unreachable", error: err instanceof Error ? err.message : "Unreachable" }
  }
}

export async function k8sFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = loadStatic()
  try {
    return await fetch(`${config.apiServer}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${currentToken()}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string>),
      },
      signal: init.signal ?? AbortSignal.timeout(getConfig().k8sHttpTimeoutMs),
      // @ts-expect-error -- undici-specific dispatcher option, not in the standard fetch types
      dispatcher: config.dispatcher,
    })
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Kubernetes API server did not respond within ${getConfig().k8sHttpTimeoutMs / 1000}s`)
    }
    throw err
  }
}

export function currentNamespace(): string {
  return loadStatic().namespace
}

export async function createSecret(
  name: string,
  stringData: Record<string, string>,
  labels?: Record<string, string>,
): Promise<void> {
  const ns = currentNamespace()
  const res = await k8sFetch(`/api/v1/namespaces/${ns}/secrets`, {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, labels },
      type: "Opaque",
      stringData,
    }),
  })
  if (!res.ok) throw new Error(`Failed to create Secret ${name} (${res.status})`)
}

export async function deleteSecret(name: string): Promise<void> {
  const ns = currentNamespace()
  const res = await k8sFetch(`/api/v1/namespaces/${ns}/secrets/${name}`, { method: "DELETE" })
  if (!res.ok && res.status !== 404) throw new Error(`Failed to delete Secret ${name} (${res.status})`)
}

export async function createJob(
  name: string,
  spec: Record<string, unknown>,
  labels?: Record<string, string>,
): Promise<void> {
  const ns = currentNamespace()
  const res = await k8sFetch(`/apis/batch/v1/namespaces/${ns}/jobs`, {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, labels },
      spec,
    }),
  })
  if (!res.ok) throw new Error(`Failed to create Job ${name} (${res.status})`)
}

export type JobPhase = "running" | "succeeded" | "failed"

export async function getJobPhase(name: string): Promise<JobPhase | "not-found"> {
  const ns = currentNamespace()
  const res = await k8sFetch(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`)
  if (res.status === 404) return "not-found"
  if (!res.ok) throw new Error(`Failed to read Job ${name} (${res.status})`)

  const body = (await res.json()) as { status?: { succeeded?: number; failed?: number } }
  if (body.status?.succeeded) return "succeeded"
  if (body.status?.failed) return "failed"
  return "running"
}

export async function deleteJob(name: string): Promise<void> {
  const ns = currentNamespace()
  const res = await k8sFetch(`/apis/batch/v1/namespaces/${ns}/jobs/${name}?propagationPolicy=Background`, {
    method: "DELETE",
  })
  if (!res.ok && res.status !== 404) throw new Error(`Failed to delete Job ${name} (${res.status})`)
}

// Scheduled mirrors (src/lib/mirrors/) install a CronJob rather than a Job: Kubernetes then
// owns the clock, which is what keeps this app free of a scheduler of its own. Everything
// below is create-or-update, because applying a mirror twice is normal — an operator editing
// its schedule, or a re-apply after the object was deleted by hand.

// POST first, then merge-patch on 409. Server-side apply would be the modern answer, but it
// needs a fieldManager and the full object shape on every call; a merge patch of the fields
// we own is enough here, and leaves anything a cluster admin added (annotations from a policy
// controller, say) alone.
async function createOrPatch(
  collectionPath: string,
  name: string,
  body: Record<string, unknown>,
  kind: string,
): Promise<void> {
  const created = await k8sFetch(collectionPath, { method: "POST", body: JSON.stringify(body) })
  if (created.ok) return
  if (created.status !== 409) throw new Error(`Failed to create ${kind} ${name} (${created.status})`)

  const patched = await k8sFetch(`${collectionPath}/${name}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify(body),
  })
  if (!patched.ok) throw new Error(`Failed to update ${kind} ${name} (${patched.status})`)
}

export async function applySecret(
  name: string,
  stringData: Record<string, string>,
  labels?: Record<string, string>,
): Promise<void> {
  await createOrPatch(
    `/api/v1/namespaces/${currentNamespace()}/secrets`,
    name,
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, labels },
      type: "Opaque",
      stringData,
    },
    "Secret",
  )
}

export async function applyCronJob(
  name: string,
  spec: Record<string, unknown>,
  labels?: Record<string, string>,
): Promise<void> {
  await createOrPatch(
    `/apis/batch/v1/namespaces/${currentNamespace()}/cronjobs`,
    name,
    {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name, labels },
      spec,
    },
    "CronJob",
  )
}

export async function deleteCronJob(name: string): Promise<void> {
  const ns = currentNamespace()
  const res = await k8sFetch(
    `/apis/batch/v1/namespaces/${ns}/cronjobs/${name}?propagationPolicy=Background`,
    { method: "DELETE" },
  )
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete CronJob ${name} (${res.status})`)
  }
}

export interface CronJobState {
  suspended: boolean
  lastScheduleTime: string | null
  lastSuccessfulTime: string | null
  activeJobs: number
}

/** Null when the CronJob is not there — a mirror the cluster has lost, which is worth saying. */
export async function getCronJobState(name: string): Promise<CronJobState | null> {
  const ns = currentNamespace()
  const res = await k8sFetch(`/apis/batch/v1/namespaces/${ns}/cronjobs/${name}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read CronJob ${name} (${res.status})`)

  const body = (await res.json()) as {
    spec?: { suspend?: boolean }
    status?: { lastScheduleTime?: string; lastSuccessfulTime?: string; active?: unknown[] }
  }
  return {
    suspended: body.spec?.suspend === true,
    lastScheduleTime: body.status?.lastScheduleTime ?? null,
    lastSuccessfulTime: body.status?.lastSuccessfulTime ?? null,
    activeJobs: body.status?.active?.length ?? 0,
  }
}

export interface JobSummary {
  name: string
  phase: JobPhase
  startTime: string | null
  completionTime: string | null
  /**
   * The Job's own labels. Mirror runs are found by a selector that already says which mirror
   * they belong to, so this is redundant there — but a cluster-wide listing selects on
   * managed-by alone and has nothing else to tell a transfer's Job from a mirror's.
   */
  labels: Record<string, string>
}

/**
 * The Jobs a CronJob has spawned, newest first — the run history of a skopeo mirror.
 *
 * They are found by label rather than by ownerReference because that is the same selector an
 * operator would use with kubectl, and because a Job only survives as long as its
 * ttlSecondsAfterFinished: this list is a recent window, never the full history. What ran
 * three weeks ago is gone from the cluster, which is why the mirror row keeps its own
 * last-run summary.
 */
export async function listJobsByLabel(
  selector: string,
  limit = 10,
  /**
   * Narrows the listing server-side, e.g. `metadata.name=transfer-abc`. Without it a caller
   * asking "is this one Job mine?" has to page through the whole namespace and gets the wrong
   * answer as soon as the first page fills up.
   */
  fieldSelector?: string,
): Promise<JobSummary[]> {
  const ns = currentNamespace()
  const res = await k8sFetch(
    `/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=${encodeURIComponent(selector)}&limit=${limit}` +
      (fieldSelector ? `&fieldSelector=${encodeURIComponent(fieldSelector)}` : ""),
  )
  if (!res.ok) throw new Error(`Failed to list Jobs (${res.status})`)

  const body = (await res.json()) as {
    items?: Array<{
      metadata?: { name?: string; creationTimestamp?: string; labels?: Record<string, string> }
      status?: { succeeded?: number; failed?: number; startTime?: string; completionTime?: string }
    }>
  }

  return (body.items ?? [])
    .map((job) => ({
      name: job.metadata?.name ?? "",
      labels: job.metadata?.labels ?? {},
      phase: (job.status?.succeeded
        ? "succeeded"
        : job.status?.failed
          ? "failed"
          : "running") as JobPhase,
      startTime: job.status?.startTime ?? job.metadata?.creationTimestamp ?? null,
      completionTime: job.status?.completionTime ?? null,
    }))
    .sort((a, b) => (b.startTime ?? "").localeCompare(a.startTime ?? ""))
}

// Everything the Gateway puts in the cluster carries this, whether it came from a transfer
// (transfers/job-spec.ts) or a scheduled mirror (mirrors/skopeo-transport.ts). It is the only
// selector that spans both, and so the only way to answer "what is running right now".
export const GATEWAY_MANAGED_BY = "app.kubernetes.io/managed-by=tessark-gateway"

/**
 * The pod logs of a Job, or why they could not be read.
 *
 * Absence is the normal case, not an error: a Job's pod is garbage collected with it after
 * ttlSecondsAfterFinished, so the logs of a transfer that failed yesterday are simply gone.
 * Saying "expired" is useful; a stack trace is not.
 */
export type JobLogs =
  | { status: "ok"; podName: string; text: string }
  | { status: "gone"; reason: string }

export async function getJobLogs(jobName: string, tailLines = 500): Promise<JobLogs> {
  const ns = currentNamespace()

  // job-name is set by the Job controller itself, not by us — it is how kubectl finds the
  // same pods, and it keeps working for CronJob-spawned Jobs whose names we never chose.
  const pods = await k8sFetch(
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
  )
  if (!pods.ok) throw new Error(`Failed to list Pods for Job ${jobName} (${pods.status})`)

  const body = (await pods.json()) as {
    items?: Array<{ metadata?: { name?: string; creationTimestamp?: string } }>
  }
  // A retried Job (backoffLimit > 0) leaves several pods behind; the newest is the attempt
  // whose failure the operator is looking at.
  const podName = (body.items ?? [])
    .slice()
    .sort((a, b) =>
      (b.metadata?.creationTimestamp ?? "").localeCompare(a.metadata?.creationTimestamp ?? ""),
    )[0]?.metadata?.name

  if (!podName) {
    return { status: "gone", reason: "The Job's pod no longer exists — it was garbage collected." }
  }

  const logs = await k8sFetch(
    `/api/v1/namespaces/${ns}/pods/${podName}/log?tailLines=${tailLines}&timestamps=true`,
  )
  // The pod can exist without logs being readable yet: a container still pulling its image
  // has none, which the API reports as 400 rather than an empty body.
  if (logs.status === 400 || logs.status === 404) {
    return { status: "gone", reason: "The container has not produced any logs yet." }
  }
  if (!logs.ok) throw new Error(`Failed to read logs of Pod ${podName} (${logs.status})`)

  return { status: "ok", podName, text: await logs.text() }
}
