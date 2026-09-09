import { currentNamespace, k8sFetch } from "@/lib/k8s/client"
import { getConfig } from "@/lib/config"

export function buildNamespace() { return getConfig().buildsNamespace ?? currentNamespace() }
export function collection(kind: "jobs" | "cronjobs" | "secrets" | "pods" | "leases") {
  const api = kind === "leases" ? "/apis/coordination.k8s.io/v1" : kind === "jobs" || kind === "cronjobs" ? "/apis/batch/v1" : "/api/v1"
  return `${api}/namespaces/${buildNamespace()}/${kind}`
}
export async function readObject<T>(kind: Parameters<typeof collection>[0], name: string): Promise<T | null> {
  const r = await k8sFetch(`${collection(kind)}/${encodeURIComponent(name)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`Could not read build ${kind} (${r.status})`)
  return r.json()
}
export async function createObject(kind: Parameters<typeof collection>[0], body: Record<string, unknown>) {
  const r = await k8sFetch(collection(kind), { method: "POST", body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`Could not create build ${kind} (${r.status})`)
  return r.json()
}
export async function patchObject(kind: Parameters<typeof collection>[0], name: string, body: Record<string, unknown>) {
  const r = await k8sFetch(`${collection(kind)}/${name}`, { method: "PATCH", headers: { "Content-Type": "application/merge-patch+json" }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`Could not update build ${kind} (${r.status})`)
}
export async function removeObject(kind: Parameters<typeof collection>[0], name: string, uid?: string) {
  const r = await k8sFetch(`${collection(kind)}/${name}`, { method: "DELETE", body: JSON.stringify({ propagationPolicy: "Foreground", ...(uid ? { preconditions: { uid } } : {}) }) })
  if (!r.ok && r.status !== 404) throw new Error(`Could not delete build ${kind} (${r.status})`)
}
export interface KubeObject {
  metadata: { name: string; uid: string; labels?: Record<string, string>; creationTimestamp?: string }
  spec?: { holderIdentity?: string }
  status?: { phase?: string; startTime?: string; completionTime?: string; conditions?: Array<{ type: string; status: string; message?: string }>; containerStatuses?: Array<{ name: string; state?: { terminated?: { message?: string; reason?: string; exitCode?: number } } }>; initContainerStatuses?: Array<{ name: string; state?: { terminated?: { message?: string; reason?: string; exitCode?: number } } }> }
}
export async function listObjects(kind: Parameters<typeof collection>[0], selector: string): Promise<KubeObject[]> {
  const items: KubeObject[] = []
  let cursor = ""
  do {
    const r = await k8sFetch(`${collection(kind)}?labelSelector=${encodeURIComponent(selector)}&limit=100&continue=${encodeURIComponent(cursor)}`)
    if (!r.ok) throw new Error(`Could not list build ${kind} (${r.status})`)
    const body = await r.json() as { items?: KubeObject[]; metadata?: { continue?: string } }
    items.push(...body.items ?? []); cursor = body.metadata?.continue ?? ""
  } while (cursor)
  return items
}
export function terminalJob(job: KubeObject): "succeeded" | "failed" | null {
  if (job.status?.conditions?.some((c) => c.type === "Complete" && c.status === "True")) return "succeeded"
  if (job.status?.conditions?.some((c) => c.type === "Failed" && c.status === "True")) return "failed"
  return null
}
export async function buildLogs(jobName: string, container = "build") {
  const pods = await listObjects("pods", `job-name=${jobName}`)
  const pod = pods[0]
  if (!pod) return { status: "gone", reason: "Logs have expired or the pod has not started." }
  const r = await k8sFetch(`${collection("pods")}/${pod.metadata.name}/log?container=${container}&tailLines=500&limitBytes=131072&timestamps=true`)
  if (r.status === 400 || r.status === 404) return { status: "gone", reason: "The container has no available logs." }
  if (!r.ok) throw new Error(`Could not read build logs (${r.status})`)
  return { status: "ok", text: await r.text() }
}
