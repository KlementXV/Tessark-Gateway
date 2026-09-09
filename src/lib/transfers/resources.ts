import { currentNamespace, k8sFetch } from "@/lib/k8s/client"
import { logger } from "@/lib/logger"

interface Resource {
  metadata: { uid: string; labels?: Record<string, string> }
}

interface TransferResources {
  jobName: string
  labels: Record<string, string>
  spec: Record<string, unknown>
  secrets: Array<{ name: string; data: Record<string, string> }>
}

export class TransferJobUnconfirmedError extends Error {}

/** Caller holds withTransferLock. Never discard credentials on an uncertain POST result. */
export async function ensureTransferResources(
  input: TransferResources,
  request: typeof k8sFetch = k8sFetch,
  namespace: string = currentNamespace(),
): Promise<void> {
  const jobs = `/apis/batch/v1/namespaces/${namespace}/jobs`
  const secrets = `/api/v1/namespaces/${namespace}/secrets`
  const jobPath = `${jobs}/${input.jobName}`
  function assertOwned(resource: Resource) {
    if (!Object.entries(input.labels).every(([key, value]) => resource.metadata.labels?.[key] === value)) {
      throw new Error("Existing Kubernetes resource belongs to another operation")
    }
  }
  async function read(path: string): Promise<Resource | null> {
    const response = await request(path)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Could not inspect transfer resource (${response.status})`)
    const resource = await response.json() as Resource
    assertOwned(resource)
    return resource
  }
  let job = await read(jobPath)
  if (!job) {
    for (const secret of input.secrets) {
      const path = `${secrets}/${secret.name}`
      const existing = await read(path)
      const body = { apiVersion: "v1", kind: "Secret", metadata: { name: secret.name, labels: input.labels }, type: "Opaque", stringData: secret.data }
      const response = await request(existing ? path : secrets, {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": existing ? "application/merge-patch+json" : "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`Could not prepare transfer credentials (${response.status})`)
    }
    let rejected = false
    try {
      const response = await request(jobs, {
        method: "POST",
        body: JSON.stringify({ apiVersion: "batch/v1", kind: "Job", metadata: { name: input.jobName, labels: input.labels }, spec: input.spec }),
      })
      if (!response.ok) {
        rejected = response.status >= 400 && response.status < 500 && response.status !== 409
        throw new Error(`Could not create transfer Job (${response.status})`)
      }
      job = await response.json() as Resource
      assertOwned(job)
    } catch (error) {
      // A timeout or conflict can follow an accepted POST. Read before reporting failure.
      // Failed inspection also leaves the secrets intact, ready for a safe retry.
      try {
        job = await read(jobPath)
      } catch {
        if (rejected) throw error
        throw new TransferJobUnconfirmedError("Job creation unconfirmed; synchronize this transfer to check its result")
      }
      if (!job) {
        if (rejected) throw error
        throw new TransferJobUnconfirmedError("Job creation unconfirmed; synchronize this transfer to check its result")
      }
    }
  }
  // Let Kubernetes collect secrets with the Job even if nobody opens the transfer page.
  // Existing jobs are adopted without rewriting their credentials.
  for (const secret of input.secrets) {
    try {
      const path = `${secrets}/${secret.name}`
      const existing = await read(path)
      if (!existing) continue
      const response = await request(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({ metadata: { uid: existing.metadata.uid, ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: input.jobName, uid: job.metadata.uid }] } }),
      })
      if (!response.ok) throw new Error(`Secret ownership update failed (${response.status})`)
    } catch (error) {
      logger.warn("Transfer secret cleanup deferred", { jobName: input.jobName, error: String(error) })
    }
  }
}
