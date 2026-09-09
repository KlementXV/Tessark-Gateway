// What the Gateway is running in Kubernetes right now, across both things that create Jobs.
//
// The cluster is the source of truth here, not the database — deliberately. A TransferTarget
// only leaves RUNNING when somebody opens its request and POST /api/transfers/[id]/sync
// reconciles it, so the database's idea of "in flight" drifts the moment nobody is looking.
// Reading the Jobs themselves also surfaces what the database cannot name at all: a Job whose
// row was deleted, or one left behind by a failed cleanup.
//
// The cost of that choice is that this is not history. A Job is garbage collected
// ttlSecondsAfterFinished after it ends (default 3600), so this is a window of roughly the
// last hour; the transfer and mirror rows remain the durable record.
import type { Prisma } from "@/generated/prisma/client"
import { getConfig } from "@/lib/config"
import { GATEWAY_MANAGED_BY, currentNamespace, listJobsByLabel, type JobPhase } from "@/lib/k8s/client"
import { prisma } from "@/lib/prisma"
import { mirrorInclude, toPublicMirror, type MirrorRow } from "@/lib/mirrors/public"
import { MIRROR_ID_LABEL } from "@/lib/mirrors/skopeo-transport"
import { describeDestination } from "@/lib/transfers/destination"
import { TRANSFER_REQUEST_LABEL, TRANSFER_TARGET_LABEL } from "@/lib/transfers/job-spec"

// One page of a namespace that should hold a handful of Jobs at a time. A cluster showing
// more than this has a cleanup problem, and a truncated list is the least of it.
const JOB_LIMIT = 100

// Everything describeDestination() needs, plus the request's frozen source reference.
const targetInclude = {
  project: { select: { id: true, name: true } },
  destRegistry: { select: { id: true, name: true } },
  transferRequest: { select: { id: true, sourceImage: true } },
} satisfies Prisma.TransferTargetInclude

type TargetRow = Prisma.TransferTargetGetPayload<{ include: typeof targetInclude }>

export type JobOrigin =
  | {
      kind: "transfer"
      transferRequestId: string
      /** The database's status for this target, which may lag what the Job actually did. */
      recordedStatus: string
      sourceImage: string
      destination: string
    }
  | { kind: "mirror"; mirrorId: string; name: string; sourceImage: string; destination: string }
  // A Job carrying the Gateway's label whose transfer or mirror is no longer in the database,
  // or which carries no identifying label at all. Rare, and worth showing rather than hiding:
  // it is consuming cluster resources in the Gateway's name and nothing else will report it.
  | { kind: "orphan" }

export interface GatewayJobView {
  name: string
  phase: JobPhase
  startTime: string | null
  completionTime: string | null
  origin: JobOrigin
}

export type ExecutionsView =
  /** K8S_ENABLED=false — the feature is off on purpose, which is not a failure to report. */
  | { status: "disabled" }
  | { status: "error"; error: string }
  | { status: "ok"; namespace: string; jobs: GatewayJobView[] }

export async function listGatewayJobs(): Promise<ExecutionsView> {
  if (!getConfig().k8sEnabled) return { status: "disabled" }

  let namespace: string
  let jobs: Awaited<ReturnType<typeof listJobsByLabel>>
  try {
    namespace = currentNamespace()
    jobs = await listJobsByLabel(GATEWAY_MANAGED_BY, JOB_LIMIT)
  } catch (err) {
    // An unreachable API server or missing RBAC renders as a message on the page rather than
    // a 500: the operator most likely to open this page is the one whose cluster is unwell.
    return { status: "error", error: err instanceof Error ? err.message : "Unreachable" }
  }

  // Two queries for the whole page rather than one per Job — a namespace with fifty running
  // mirrors would otherwise be fifty round trips to Postgres.
  const targetIds = jobs.map((job) => job.labels[TRANSFER_TARGET_LABEL]).filter(Boolean)
  const mirrorIds = jobs.map((job) => job.labels[MIRROR_ID_LABEL]).filter(Boolean)

  const [targets, mirrors] = await Promise.all([
    targetIds.length
      ? prisma.transferTarget.findMany({ where: { id: { in: targetIds } }, include: targetInclude })
      : Promise.resolve([] as TargetRow[]),
    mirrorIds.length
      ? prisma.scheduledMirror.findMany({ where: { id: { in: mirrorIds } }, include: mirrorInclude })
      : Promise.resolve([] as MirrorRow[]),
  ])

  const targetById = new Map(targets.map((target) => [target.id, target]))
  const mirrorById = new Map(mirrors.map((mirror) => [mirror.id, mirror]))

  return {
    status: "ok",
    namespace,
    jobs: jobs.filter((job) => !job.labels["tessark.io/build-id"]).map((job) => ({
      name: job.name,
      phase: job.phase,
      startTime: job.startTime,
      completionTime: job.completionTime,
      origin: originOf(job.labels, targetById, mirrorById),
    })),
  }
}

function originOf(
  labels: Record<string, string>,
  targetById: Map<string, TargetRow>,
  mirrorById: Map<string, MirrorRow>,
): JobOrigin {
  const target = targetById.get(labels[TRANSFER_TARGET_LABEL] ?? "")
  if (target) {
    return {
      kind: "transfer",
      transferRequestId: labels[TRANSFER_REQUEST_LABEL] ?? target.transferRequestId,
      recordedStatus: target.status,
      sourceImage: target.transferRequest.sourceImage,
      destination: describeDestination(target),
    }
  }

  const mirror = mirrorById.get(labels[MIRROR_ID_LABEL] ?? "")
  if (mirror) {
    const view = toPublicMirror(mirror)
    return {
      kind: "mirror",
      mirrorId: mirror.id,
      name: view.name,
      sourceImage: view.sourceImage,
      destination: view.destination,
    }
  }

  return { kind: "orphan" }
}
