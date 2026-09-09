// Everything the Gateway has made happen, whatever ran it.
//
// Three engines move images and each keeps its own log: Kubernetes runs the skopeo Jobs
// (one-off transfers, and the mirrors on the skopeo transport), Harbor runs the replication
// policies behind the mirrors on the harbor transport, and Harbor also runs the cluster mesh.
// Until they were folded together here, "did last night's mirror run?" had a different answer
// depending on a transport the operator had no reason to remember, and a skopeo mirror was
// listed twice — once as a Job, once inside its own row.
//
// What this is not is a durable history. The Kubernetes half is a window of roughly
// `ttlSecondsAfterFinished` (default 3600), and Harbor keeps its executions as long as it
// keeps them; the transfer, mirror and link rows remain the record.
import { prisma } from "@/lib/prisma"
import { listReplicationOverview } from "@/lib/clusters/replication-view"
import { listGatewayJobs } from "@/lib/jobs/view"
import { listHarborMirrorRuns } from "@/lib/mirrors/view"

export type ActivityKind = "transfer" | "mirror" | "mesh" | "orphan" | "build"
export type ActivityStatus = "running" | "succeeded" | "failed" | "unknown"

/** Which engine's log this line came out of — it decides what can be offered next to it. */
export type ActivityEngine = "kubernetes" | "harbor"

export interface ActivityEntry {
  /** Unique across engines: two of them number their runs from 1. */
  id: string
  kind: ActivityKind
  engine: ActivityEngine
  status: ActivityStatus
  /** What ran: a Job name, a mirror name, or "Harbor A → Harbor B" for a mesh link. */
  title: string
  source: string | null
  destination: string | null
  startTime: string | null
  endTime: string | null
  /** Artifact counts, a pod name — whatever the engine says beyond the status. */
  detail: string | null
  /** The Kubernetes Job whose logs can be read, when there is one. */
  jobName: string | null
  /** Where to go to act on this, when there is somewhere. */
  href: string | null
  /**
   * The Job has settled but the database still records the transfer as running. Nothing else
   * reports this: a target only leaves RUNNING when somebody opens its request.
   */
  stale: boolean
}

/** A part of the picture that could not be read — said out loud rather than shown as empty. */
export type ActivityNotice =
  | { kind: "k8sDisabled" }
  | { kind: "k8sError"; detail: string }
  /** One named Harbor — a mirror's registry, or a mesh member — that would not answer. */
  | { kind: "harborError"; subject: string; detail: string }
  /** A whole half of the feed failed before it could name anything. */
  | { kind: "mirrorsUnreadable"; detail: string }
  | { kind: "meshUnreadable"; detail: string }

export interface ActivityView {
  entries: ActivityEntry[]
  /** The namespace the Kubernetes half was read from, null when it was not read at all. */
  namespace: string | null
  notices: ActivityNotice[]
}

// Newest first, with never-started runs last: a queued execution carries no start time, and
// sorting those to the top would bury the runs that actually say something.
function byStartDesc(a: ActivityEntry, b: ActivityEntry): number {
  if (!a.startTime) return b.startTime ? 1 : 0
  if (!b.startTime) return -1
  return b.startTime.localeCompare(a.startTime)
}

// Harbor's own status vocabulary, which is neither a Gateway enum nor stable-cased across
// releases. An unrecognised value becomes "unknown" rather than a colour that lies.
function harborStatus(status: string): ActivityStatus {
  const value = status.toLowerCase()
  if (value === "succeed" || value === "succeeded") return "succeeded"
  if (value === "failed" || value === "error") return "failed"
  if (value === "inprogress" || value === "running" || value === "pending") return "running"
  return "unknown"
}

function countsDetail(execution: { total: number; succeed: number; failed: number }): string | null {
  if (execution.total === 0 && execution.failed === 0) return null
  return `${execution.succeed}/${execution.total}${execution.failed > 0 ? `, ${execution.failed} failed` : ""}`
}

export async function listActivity(): Promise<ActivityView> {
  // Three independent reads: one unwell Harbor must not cost the Kubernetes half, and an
  // unreachable API server must not blank what Harbor was perfectly willing to say.
  const [jobs, harborMirrors, clusters] = await Promise.all([
    listGatewayJobs(),
    listHarborMirrorRuns().catch((err) => err as Error),
    listReplicationOverview().catch((err) => err as Error),
  ])

  const entries: ActivityEntry[] = []
  const buildRuns = await prisma.buildRun.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { build: { select: { name: true } }, revision: { select: { destination: true } } } })
  for (const run of buildRuns) entries.push({
    id: `build:${run.id}`, kind: "build", engine: "kubernetes",
    status: run.status === "pending" || run.status === "running" ? "running" : run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "unknown",
    title: run.build.name, source: run.commit, destination: run.revision.destination,
    startTime: (run.startedAt ?? run.createdAt).toISOString(), endTime: run.completedAt?.toISOString() ?? null,
    detail: run.digest ?? run.error, jobName: null, href: "/registries/builds", stale: false,
  })
  const notices: ActivityNotice[] = []
  let namespace: string | null = null

  if (jobs.status === "disabled") notices.push({ kind: "k8sDisabled" })
  if (jobs.status === "error") notices.push({ kind: "k8sError", detail: jobs.error })
  if (jobs.status === "ok") {
    namespace = jobs.namespace
    for (const job of jobs.jobs) {
      const origin = job.origin
      entries.push({
        id: `job:${job.name}`,
        kind: origin.kind,
        engine: "kubernetes",
        status: job.phase,
        title: job.name,
        source: origin.kind === "orphan" ? null : origin.sourceImage,
        destination: origin.kind === "orphan" ? null : origin.destination,
        startTime: job.startTime,
        endTime: job.completionTime,
        detail: origin.kind === "mirror" ? origin.name : null,
        jobName: job.name,
        // The admin queue rather than a per-request route: there is no page for a single
        // transfer, and a query parameter the queue ignores would be a link that does nothing.
        href:
          origin.kind === "transfer"
            ? "/requests"
            : origin.kind === "mirror"
              ? "/registries/mirrors"
              : null,
        stale:
          origin.kind === "transfer" &&
          job.phase !== "running" &&
          origin.recordedStatus === "RUNNING",
      })
    }
  }

  if (harborMirrors instanceof Error) {
    notices.push({ kind: "mirrorsUnreadable", detail: harborMirrors.message })
  } else {
    for (const { mirror, runs, error } of harborMirrors) {
      if (error) notices.push({ kind: "harborError", subject: mirror.name, detail: error })
      for (const run of runs) {
        entries.push({
          id: `mirror:${mirror.id}:${run.id}`,
          kind: "mirror",
          engine: "harbor",
          status: run.status,
          title: mirror.name,
          source: mirror.sourceImage,
          destination: mirror.destination,
          startTime: run.startTime,
          endTime: run.endTime,
          detail: run.detail,
          jobName: null,
          href: "/registries/mirrors",
          stale: false,
        })
      }
    }
  }

  if (clusters instanceof Error) {
    notices.push({ kind: "meshUnreadable", detail: clusters.message })
  } else {
    for (const cluster of clusters) {
      for (const unreadable of cluster.unreadable) {
        notices.push({
          kind: "harborError",
          subject: unreadable.registryName,
          detail: unreadable.error,
        })
      }
      for (const run of cluster.recent) {
        entries.push({
          // The member has to be in the key: Harbor numbers its executions per instance, so
          // two members of the same cluster routinely both hold a run numbered 253.
          id: `mesh:${cluster.id}:${run.sourceRegistryId}:${run.id}`,
          kind: "mesh",
          engine: "harbor",
          status: harborStatus(run.status),
          title: `${run.sourceName} → ${run.destName}`,
          source: null,
          destination: null,
          startTime: run.startTime,
          endTime: run.endTime,
          detail: countsDetail(run),
          jobName: null,
          href: `/registries/clusters/${cluster.id}`,
          stale: false,
        })
      }
    }
  }

  entries.sort(byStartDesc)
  return { entries, namespace, notices }
}
