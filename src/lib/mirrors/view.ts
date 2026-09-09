// What each mirror has actually done, read back from whichever transport is running it.
//
// The two speak different vocabularies — Harbor reports executions with statuses like
// "Succeed", Kubernetes reports Jobs with succeeded/failed counters — and both are folded
// into one shape here. The page has no business knowing which transport a row uses in order
// to render its history; the transport is a deployment detail, the runs are the point.
import { errorMessage } from "@/lib/clusters/fanout"
import { getConfig } from "@/lib/config"
import { getCronJobState, listJobsByLabel } from "@/lib/k8s/client"
import { prisma } from "@/lib/prisma"
import { listHarborReplicationExecutions } from "@/lib/registries/harbor"
import { resolveConnection } from "@/lib/registries/resolve"
import { mirrorLabelSelector } from "./skopeo-transport"
import { nextRunAt } from "./cron"
import { mirrorInclude, toPublicMirror, type PublicMirror } from "./public"

export type MirrorRunStatus = "succeeded" | "failed" | "running" | "unknown"

export interface MirrorRunView {
  id: string
  status: MirrorRunStatus
  startTime: string | null
  endTime: string | null
  /** Whatever the transport says beyond the status — artifact counts, the Job's name. */
  detail: string | null
}

export interface MirrorWithRuns extends PublicMirror {
  runs: MirrorRunView[]
  /** Why the runs could not be read — an unreachable Harbor, a missing CronJob, no RBAC. */
  runsError: string | null
  /** The transport says the schedule is not actually armed, whatever the row claims. */
  suspended: boolean
  /**
   * When the schedule fires next, ISO/UTC — null when it will not fire at all: disabled,
   * suspended on its transport, never installed, or a crontab that matches no date.
   *
   * Computed rather than read back from the transport, because neither offers it: Kubernetes
   * publishes only `lastScheduleTime`, and Harbor's policy carries the expression and nothing
   * else. The clock is still theirs — this only reads the same expression they were handed.
   */
  nextRunAt: string | null
}

const RUN_LIMIT = 5

function harborStatus(status: string): MirrorRunStatus {
  const value = status.toLowerCase()
  if (value === "succeed" || value === "succeeded") return "succeeded"
  if (value === "failed" || value === "error") return "failed"
  if (value === "inprogress" || value === "running" || value === "pending") return "running"
  return "unknown"
}

export async function listMirrorsWithRuns(): Promise<MirrorWithRuns[]> {
  const mirrors = await prisma.scheduledMirror.findMany({
    include: mirrorInclude,
    orderBy: { name: "asc" },
  })

  return Promise.all(
    mirrors.map(async (mirror) => {
      const base = toPublicMirror(mirror)
      try {
        const { runs, suspended } =
          mirror.transport === "harbor"
            ? await harborRuns(mirror.harborRegistryId, mirror.harborPolicyId)
            : await skopeoRuns(mirror.k8sCronJobName, mirror.id)
        const armed = base.enabled && base.applied && !suspended
        return {
          ...base,
          runs,
          runsError: null,
          suspended,
          nextRunAt: armed ? (nextRunAt(base.schedule)?.toISOString() ?? null) : null,
        }
      } catch (err) {
        // One unreachable Harbor must not blank the whole page: the mirror still renders with
        // its definition, and the reason sits next to it.
        // The schedule is a property of the row, not of the transport that failed to answer:
        // an unreachable Harbor does not stop us saying when the mirror is meant to run.
        return {
          ...base,
          runs: [],
          runsError: errorMessage(err),
          suspended: false,
          nextRunAt:
            base.enabled && base.applied ? (nextRunAt(base.schedule)?.toISOString() ?? null) : null,
        }
      }
    }),
  )
}

/**
 * The harbor-transport mirrors only, with what Harbor ran under each.
 *
 * The activity page needs these and nothing else: a skopeo mirror's runs *are* Kubernetes
 * Jobs carrying the Gateway's label, so they already arrive through listGatewayJobs() and
 * asking for them again here would list every one of them twice.
 */
export async function listHarborMirrorRuns(): Promise<
  Array<{ mirror: PublicMirror; runs: MirrorRunView[]; error: string | null }>
> {
  const mirrors = await prisma.scheduledMirror.findMany({
    where: { transport: "harbor" },
    include: mirrorInclude,
    orderBy: { name: "asc" },
  })

  return Promise.all(
    mirrors.map(async (mirror) => {
      const base = toPublicMirror(mirror)
      try {
        const { runs } = await harborRuns(mirror.harborRegistryId, mirror.harborPolicyId)
        return { mirror: base, runs, error: null }
      } catch (err) {
        return { mirror: base, runs: [], error: errorMessage(err) }
      }
    }),
  )
}

async function harborRuns(
  harborRegistryId: string | null,
  harborPolicyId: number | null,
): Promise<{ runs: MirrorRunView[]; suspended: boolean }> {
  if (!harborRegistryId || harborPolicyId === null) return { runs: [], suspended: false }

  const registry = await prisma.registry.findUnique({ where: { id: harborRegistryId } })
  if (!registry) return { runs: [], suspended: false }

  const executions = await listHarborReplicationExecutions(
    resolveConnection(registry),
    RUN_LIMIT,
    harborPolicyId,
  )

  return {
    runs: executions.map((execution) => ({
      id: String(execution.id),
      status: harborStatus(execution.status),
      startTime: execution.startTime,
      endTime: execution.endTime,
      detail:
        execution.total === 0 && execution.failed === 0
          ? null
          : `${execution.succeed}/${execution.total}${execution.failed > 0 ? `, ${execution.failed} failed` : ""}`,
    })),
    suspended: false,
  }
}

async function skopeoRuns(
  cronJobName: string | null,
  mirrorId: string,
): Promise<{ runs: MirrorRunView[]; suspended: boolean }> {
  if (!cronJobName || !getConfig().k8sEnabled) return { runs: [], suspended: false }

  const state = await getCronJobState(cronJobName)
  const jobs = await listJobsByLabel(mirrorLabelSelector(mirrorId), RUN_LIMIT)

  return {
    runs: jobs.map((job) => ({
      id: job.name,
      status: job.phase,
      startTime: job.startTime,
      endTime: job.completionTime,
      detail: job.name,
    })),
    // A CronJob that is not there at all is not suspended, it is missing — which the row's
    // own `applied` flag is what reports. Suspension is only what the object itself says.
    suspended: state?.suspended ?? false,
  }
}
