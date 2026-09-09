// The skopeo transport: a Kubernetes CronJob running the very same `skopeo copy` a one-shot
// transfer runs. Kubernetes holds the clock, the copy happens in the Gateway's namespace —
// so it is the pod's network that must reach both ends, not the destination Harbor's — and it
// is the only form that can deliver to a Harbor the Gateway does not administer.
//
// Everything about the copy itself (image, resources, security context, rule overrides) comes
// from src/lib/transfers/job-spec.ts, unchanged: a mirror that ran differently from the
// transfer it repeats would be a second implementation to keep honest.
import { pickWriteMember } from "@/lib/clusters/members"
import { getConfig } from "@/lib/config"
import {
  applyCronJob,
  applySecret,
  createJob,
  deleteCronJob,
  deleteSecret,
} from "@/lib/k8s/client"
import { prisma } from "@/lib/prisma"
import { resolveJobCaPem } from "@/lib/settings/enterprise-ca"
import { resolveConnection, skopeoNeedsInsecure } from "@/lib/registries/resolve"
import { RegistryRole, type ScheduledMirror, type UpstreamSource } from "@/generated/prisma/client"
import {
  resolvePushCredentials,
  resolveSourceCredentials,
  type PushCredentials,
} from "@/lib/transfers/credentials"
import { buildDestinationImage } from "@/lib/transfers/image-ref"
import { buildSkopeoJobSpec } from "@/lib/transfers/job-spec"
import { findMatchingRule } from "@/lib/transfers/rules"
import { parseSkopeoOverrides } from "@/lib/transfers/skopeo-overrides"
import { buildSourceImageRef, shortRepoName } from "@/lib/sources/repo"
import type { RegistryConnection } from "@/lib/registries/types"
import { MirrorTransportError, sourceRepoPath } from "./harbor-transport"

type MirrorWithSource = ScheduledMirror & { source: UpstreamSource | null }

export const MIRROR_ID_LABEL = "tessark.io/mirror-id"

function cronJobName(mirrorId: string): string {
  return `mirror-${mirrorId}`.toLowerCase()
}

function secretName(mirrorId: string): string {
  return `${cronJobName(mirrorId)}-creds`
}

export function mirrorLabelSelector(mirrorId: string): string {
  return `${MIRROR_ID_LABEL}=${mirrorId}`
}

function mirrorLabels(mirrorId: string): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "tessark-gateway",
    [MIRROR_ID_LABEL]: mirrorId,
  }
}

interface ResolvedDestination {
  conn: RegistryConnection
  projectName: string
  push: PushCredentials
}

// The same two forms resolveDestination() handles in launch.ts, and the same rule: a managed
// project is written through one healthy member of its cluster with the project's own robot,
// a delivery registry through the credentials stored on its row — there is no robot to use on
// a Harbor the Gateway does not administer.
async function resolveDestination(mirror: ScheduledMirror): Promise<ResolvedDestination> {
  if (mirror.destRegistryId) {
    const registry = await prisma.registry.findUnique({ where: { id: mirror.destRegistryId } })
    if (!registry) throw new MirrorTransportError("The destination registry no longer exists.", 404)
    if (registry.role !== RegistryRole.DELIVERY) {
      throw new MirrorTransportError(
        `${registry.name} is no longer a delivery registry — recreate this mirror against one of its projects.`,
        409,
      )
    }
    const conn = resolveConnection(registry)
    if (!conn.username || !conn.secret) {
      throw new MirrorTransportError(
        `${registry.name} has no stored credentials — add the account the Gateway should push with.`,
        400,
      )
    }
    return {
      conn,
      projectName: mirror.destProjectName!,
      push: { username: conn.username, secret: conn.secret },
    }
  }

  const project = await prisma.project.findUnique({
    where: { id: mirror.projectId! },
    select: {
      id: true,
      name: true,
      status: true,
      clusterId: true,
      robotAccounts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { placements: true },
      },
    },
  })
  if (!project) throw new MirrorTransportError("The destination project no longer exists.", 404)
  if (project.status !== "ACTIVE") {
    throw new MirrorTransportError(`${project.name} must be active before mirroring into it.`, 400)
  }

  const member = await pickWriteMember(project.clusterId, project.id)
  if (!member) {
    throw new MirrorTransportError(
      `No healthy Harbor in ${project.name}'s cluster is currently reachable — try again once one is back.`,
    )
  }

  const push = await resolvePushCredentials(project, member)
  if (!push) {
    throw new MirrorTransportError(
      `${project.name} has no robot account yet — create one first so Gateway can push the mirrored image.`,
      400,
    )
  }

  return { conn: member.conn, projectName: project.name, push }
}

async function sourceImageRef(mirror: MirrorWithSource): Promise<string> {
  if (mirror.source) {
    return buildSourceImageRef(mirror.source.host, mirror.sourceRepo, mirror.sourceTag)
  }
  const registry = await prisma.registry.findUnique({ where: { id: mirror.sourceRegistryId! } })
  if (!registry) throw new MirrorTransportError("The source registry no longer exists.", 404)
  const host = new URL(resolveConnection(registry).baseUrl).host
  return `${host}/${sourceRepoPath(mirror)}:${mirror.sourceTag}`
}

// The Secret and the Job spec, built together because the spec only carries the *flag* that
// names a credential — the values themselves live in the Secret and reach the container as
// environment variables, never as literals in a pod spec anyone can read back.
async function buildRun(mirror: MirrorWithSource) {
  const destination = await resolveDestination(mirror)
  const sourceRegistry = mirror.sourceRegistryId
    ? await prisma.registry.findUnique({ where: { id: mirror.sourceRegistryId } })
    : null

  const targetRepo = mirror.targetRepo || shortRepoName(mirror.sourceRepo)
  const destImage = buildDestinationImage(
    destination.conn.baseUrl,
    destination.projectName,
    targetRepo,
    mirror.sourceTag,
  )

  const secretData: Record<string, string> = {
    DEST_USERNAME: destination.push.username,
    DEST_PASSWORD: destination.push.secret,
  }
  // The enterprise CA is instance-wide (Policy › Enterprise CA), and a mirror has no per-run
  // switch: it is a standing intention, so it follows the instance default — and the beta flag,
  // which makes resolveJobCaPem() return null and installs a CronJob with no CA rather than
  // failing.
  const caPem = await resolveJobCaPem()
  const caData: Record<string, string> = caPem ? { "ca.crt": caPem } : {}
  let sourceArgs = ""
  const credentials = resolveSourceCredentials({ source: mirror.source, sourceRegistry })
  if (credentials?.kind === "basic") {
    secretData.SRC_USERNAME = credentials.username
    secretData.SRC_PASSWORD = credentials.secret
    sourceArgs = ' --src-creds="$SRC_USERNAME:$SRC_PASSWORD"'
  } else if (credentials?.kind === "token") {
    secretData.SRC_TOKEN = credentials.secret
    sourceArgs = ' --src-registry-token="$SRC_TOKEN"'
  }

  // Re-resolved on every apply rather than snapshotted, exactly as launch.ts does it: the
  // rule's overrides describe how this direction should run now.
  const rule = await findMatchingRule({
    sourceUpstreamId: mirror.sourceId,
    sourceRegistryId: mirror.sourceRegistryId,
    repo: mirror.sourceRepo,
    destRegistryId: mirror.destRegistryId,
    destProjectName: destination.projectName,
  })

  const labels = mirrorLabels(mirror.id)
  const jobSpec = buildSkopeoJobSpec({
    secretName: secretName(mirror.id),
    // No digest pinning, unlike a transfer: a mirror follows the tag wherever it moves, which
    // is the whole reason it repeats.
    sourceImage: await sourceImageRef(mirror),
    destImage,
    sourceArgs,
    labels,
    sourceInsecure: sourceRegistry ? skopeoNeedsInsecure(sourceRegistry) : false,
    destInsecure: skopeoNeedsInsecure(destination.conn),
    caPem,
    overrides: rule ? parseSkopeoOverrides(rule.skopeoOverrides) : {},
  })

  return { secretData, caData, jobSpec, labels, destImage }
}

/**
 * Installs (or re-installs) the CronJob and the Secret it reads.
 *
 * The credentials are materialised into the Secret at apply time, so a robot whose secret is
 * rotated afterwards leaves this mirror authenticating with the old one until it is applied
 * again. That is the cost of not having a scheduler in the pod: nothing runs between ticks to
 * refresh it, and re-applying is one action away.
 */
export async function applySkopeoMirror(mirror: MirrorWithSource): Promise<{ cronJobName: string }> {
  if (!getConfig().k8sEnabled) {
    throw new MirrorTransportError("Kubernetes is disabled on this instance (K8S_ENABLED=false).", 503)
  }

  const { secretData, caData, jobSpec, labels } = await buildRun(mirror)
  const name = cronJobName(mirror.id)

  await applySecret(secretName(mirror.id), secretData, labels)
  if (Object.keys(caData).length) {
    await applySecret(`${secretName(mirror.id)}-ca`, caData, labels)
  } else {
    // A CA that was removed from the registry or source must leave with it: applySecret only
    // ever writes, so without this the previous bundle would stay mounted on every tick.
    // Idempotent — deleteSecret treats 404 as done.
    await deleteSecret(`${secretName(mirror.id)}-ca`)
  }
  await applyCronJob(
    name,
    {
      schedule: mirror.schedule,
      // Kubernetes reads the schedule in UTC unless told otherwise, and every schedule in
      // this app is stored as UTC — saying so explicitly keeps a cluster whose controller
      // defaults differently from silently shifting the hour.
      timeZone: "Etc/UTC",
      suspend: !mirror.enabled,
      // A run that overruns its next tick means a slow copy, not a reason to start a second
      // one against the same destination tag.
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      startingDeadlineSeconds: 300,
      jobTemplate: { metadata: { labels }, spec: jobSpec },
    },
    labels,
  )

  return { cronJobName: name }
}

export async function removeSkopeoMirror(mirror: ScheduledMirror): Promise<void> {
  if (!mirror.k8sCronJobName || !getConfig().k8sEnabled) return
  try {
    await deleteCronJob(mirror.k8sCronJobName)
    await deleteSecret(secretName(mirror.id))
    await deleteSecret(`${secretName(mirror.id)}-ca`)
  } catch {
    // Same trade as the Harbor side: the row goes regardless, and an orphan CronJob in a
    // namespace an operator can see beats a mirror the Gateway has lost track of.
  }
}

/**
 * Runs the copy now, as a one-off Job beside the CronJob rather than by faking a tick.
 *
 * Named with a timestamp because Job names are immutable and a second manual run would
 * otherwise collide with the first one still sitting in the namespace under its TTL.
 */
export async function runSkopeoMirrorNow(mirror: MirrorWithSource): Promise<string> {
  if (!getConfig().k8sEnabled) {
    throw new MirrorTransportError("Kubernetes is disabled on this instance (K8S_ENABLED=false).", 503)
  }

  const { secretData, caData, jobSpec, labels } = await buildRun(mirror)
  await applySecret(secretName(mirror.id), secretData, labels)
  // The spec references the CA Secret by name, so a manual run must not assume the last apply
  // left the right bundle there — the CA may have been rotated since.
  if (Object.keys(caData).length) await applySecret(`${secretName(mirror.id)}-ca`, caData, labels)

  const name = `${cronJobName(mirror.id)}-run-${Date.now()}`
  await createJob(name, jobSpec, labels)
  return name
}
