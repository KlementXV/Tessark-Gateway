import type { PlacementStatus } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  listHarborReplicationExecutions,
  type HarborReplicationExecution,
} from "@/lib/registries/harbor"
import { errorMessage } from "./fanout"
import { loadClusterMembers, type ClusterMember } from "./members"

// The read-only counterpart to replication.ts. That file weaves the mesh; this one answers
// "and is it doing anything?" — a question the Gateway's own tables cannot answer, since
// they record the policies it created, never the pushes Harbor performed under them. Both
// halves are shown side by side on purpose: a link the Gateway believes is ACTIVE whose last
// execution failed an hour ago looks healthy in the database and is not.

export interface ReplicationExecutionView {
  id: number
  status: string
  trigger: string
  startTime: string | null
  endTime: string | null
  total: number
  succeed: number
  failed: number
  inProgress: number
}

/** One directed edge of the mesh, as the Gateway recorded it plus what Harbor did with it. */
export interface ReplicationEdgeView {
  id: string
  sourceRegistryId: string
  sourceName: string
  destRegistryId: string
  destName: string
  status: PlacementStatus
  lastError: string | null
  catchUpRequested: boolean
  catchUpStatus: string | null
  catchUpError: string | null
  catchUpExecutionId: number | null
  lastCatchUpAt: string | null
  nextAttemptAt: string
  harborPolicyId: number | null
  updatedAt: string
  /** Null when this policy has never run — but only trust it when executionsReadable. */
  lastExecution: ReplicationExecutionView | null
  /**
   * Whether the source Harbor answered at all. Without it, "never replicated" and "we could
   * not ask" render identically, and the page whose whole job is to contradict the database
   * ends up making a claim of its own that it cannot support.
   */
  executionsReadable: boolean
  /** Last time the *source* Harbor confirmed it can reach the destination. */
  lastPingAt: string | null
  /** The peer URL the endpoint on the source Harbor actually carries. */
  appliedBaseUrl: string | null
}

export interface ReplicationActivityView extends ReplicationExecutionView {
  /**
   * Which member produced this run. Required, not decorative: Harbor numbers executions per
   * instance, so `id` alone repeats across the members of one cluster and anything keyed on
   * (cluster, execution) collides on two unrelated runs.
   */
  sourceRegistryId: string
  sourceName: string
  destName: string
}

export interface ReplicationClusterView {
  id: string
  name: string
  mode: string
  cron: string | null
  memberCount: number
  /** N×(N-1): what a full mesh would need. Compared against `links` to spot a torn mesh. */
  expectedLinks: number
  links: ReplicationEdgeView[]
  /** Newest runs across the whole cluster, source Harbors merged. */
  recent: ReplicationActivityView[]
  pendingCleanup: Array<{ id: string; lastError: string | null; nextAttemptAt: string }>
  /** Members whose execution log could not be read, with the reason. */
  unreadable: Array<{ registryName: string; error: string }>
}

const RECENT_LIMIT = 12

// Drops policyId: it is a Harbor-side identifier the page never shows, and the edge it
// belongs to is already known by the time this runs.
function toExecutionView(execution: HarborReplicationExecution): ReplicationExecutionView {
  return {
    id: execution.id,
    status: execution.status,
    trigger: execution.trigger,
    startTime: execution.startTime,
    endTime: execution.endTime,
    total: execution.total,
    succeed: execution.succeed,
    failed: execution.failed,
    inProgress: execution.inProgress,
  }
}

// Newest first, with never-started runs last: Harbor leaves start_time empty on a queued
// execution, and sorting those to the top would bury the runs that actually say something.
function byStartDesc(a: { startTime: string | null }, b: { startTime: string | null }): number {
  if (!a.startTime) return 1
  if (!b.startTime) return -1
  return b.startTime.localeCompare(a.startTime)
}

async function buildCluster(
  cluster: { id: string; name: string; replicationMode: string; replicationCron: string | null },
  members: ClusterMember[]
): Promise<ReplicationClusterView> {
  const memberIds = members.map((m) => m.registryId)
  const byId = new Map(members.map((m) => [m.registryId, m]))

  const links = await prisma.replicationLink.findMany({
    where: { sourceRegistryId: { in: memberIds }, destRegistryId: { in: memberIds } },
    orderBy: [{ sourceRegistryId: "asc" }, { destRegistryId: "asc" }],
  })

  // One request per source Harbor rather than one per link, and never for a member with no
  // policy at all — a cluster in "none" mode then costs no network at all.
  const sources = members.filter((m) =>
    links.some((l) => l.sourceRegistryId === m.registryId && l.harborPolicyId !== null)
  )
  const unreadable: ReplicationClusterView["unreadable"] = []

  const logs = new Map<string, Map<number, HarborReplicationExecution[]>>()
  const readable = new Set<string>()
  await Promise.all(
    sources.map(async (source) => {
      try {
        const executions = await listHarborReplicationExecutions(source.conn)
        const byPolicy = new Map<number, HarborReplicationExecution[]>()
        for (const execution of executions) {
          const list = byPolicy.get(execution.policyId) ?? []
          list.push(execution)
          byPolicy.set(execution.policyId, list)
        }
        logs.set(source.registryId, byPolicy)
        readable.add(source.registryId)
      } catch (err) {
        // A member that is down is a fact about the mesh, not a failure of this page: the
        // rest of the cluster still renders, and the reason is shown next to it.
        unreadable.push({ registryName: source.registryName, error: errorMessage(err) })
      }
    })
  )

  // The bulk read above is a *window* — the member's newest runs, all policies merged. In a
  // busy mesh one chatty edge fills it and a quiet edge falls out, which would render as
  // "never replicated" for a link that works. So every policy the window missed is asked for
  // directly, one row each. Usually none of them: the window covers a quiet cluster whole, and
  // the cost only appears where the merged read was actually lossy.
  const missing = links.filter(
    (link) =>
      link.harborPolicyId !== null &&
      readable.has(link.sourceRegistryId) &&
      !logs.get(link.sourceRegistryId)?.has(link.harborPolicyId)
  )
  await Promise.all(
    missing.map(async (link) => {
      const source = byId.get(link.sourceRegistryId)
      if (!source) return
      try {
        const runs = await listHarborReplicationExecutions(source.conn, 1, link.harborPolicyId!)
        if (runs.length > 0) logs.get(link.sourceRegistryId)?.set(link.harborPolicyId!, runs)
      } catch {
        // The member answered the bulk read a moment ago; a single policy failing now is not
        // worth demoting the whole source to unreadable. The edge simply shows no run.
      }
    })
  )

  const edges: ReplicationEdgeView[] = links.map((link) => {
    const runs =
      link.harborPolicyId === null
        ? []
        : (logs.get(link.sourceRegistryId)?.get(link.harborPolicyId) ?? [])
    const sorted = [...runs].sort(byStartDesc)

    return {
      id: link.id,
      sourceRegistryId: link.sourceRegistryId,
      sourceName: byId.get(link.sourceRegistryId)?.registryName ?? link.sourceRegistryId,
      destRegistryId: link.destRegistryId,
      destName: byId.get(link.destRegistryId)?.registryName ?? link.destRegistryId,
      status: link.status,
      lastError: link.lastError,
      catchUpRequested: link.catchUpRequested,
      catchUpStatus: link.executionStatus,
      catchUpError: link.executionError,
      catchUpExecutionId: link.lastExecutionId,
      lastCatchUpAt: link.lastCatchUpAt?.toISOString() ?? null,
      nextAttemptAt: link.nextAttemptAt.toISOString(),
      harborPolicyId: link.harborPolicyId,
      updatedAt: link.updatedAt.toISOString(),
      lastExecution: sorted[0] ? toExecutionView(sorted[0]) : null,
      // An edge with no policy has nothing to read and is not "unreadable" — it simply has not
      // been wired yet, which its status already says.
      executionsReadable: link.harborPolicyId === null || readable.has(link.sourceRegistryId),
      lastPingAt: link.lastPingAt?.toISOString() ?? null,
      appliedBaseUrl: link.appliedBaseUrl,
    }
  })

  const recent: ReplicationActivityView[] = []
  // (member, execution) is the real identity of a run — see ReplicationActivityView. Tracked
  // here as well so a policy id somehow shared by two links cannot list the same run twice.
  const seen = new Set<string>()
  for (const link of links) {
    if (link.harborPolicyId === null) continue
    const runs = logs.get(link.sourceRegistryId)?.get(link.harborPolicyId) ?? []
    for (const run of runs) {
      const key = `${link.sourceRegistryId}:${run.id}`
      if (seen.has(key)) continue
      seen.add(key)
      recent.push({
        ...toExecutionView(run),
        sourceRegistryId: link.sourceRegistryId,
        sourceName: byId.get(link.sourceRegistryId)?.registryName ?? link.sourceRegistryId,
        destName: byId.get(link.destRegistryId)?.registryName ?? link.destRegistryId,
      })
    }
  }
  recent.sort(byStartDesc)

  return {
    id: cluster.id,
    name: cluster.name,
    mode: cluster.replicationMode,
    cron: cluster.replicationCron,
    memberCount: members.length,
    expectedLinks:
      cluster.replicationMode === "none" ? 0 : members.length * Math.max(members.length - 1, 0),
    links: edges,
    recent: recent.slice(0, RECENT_LIMIT),
    pendingCleanup: (await prisma.replicationCleanup.findMany({ where: { OR: [
      { sourceRegistryId: { in: memberIds } }, { destRegistryId: { in: memberIds } },
    ] }, select: { id: true, lastError: true, nextAttemptAt: true } })).map((row) => ({
      ...row, nextAttemptAt: row.nextAttemptAt.toISOString(),
    })),
    unreadable,
  }
}

/** One cluster's mesh — what its own page shows, and the only view the operator acts on. */
export async function getClusterReplication(clusterId: string): Promise<ReplicationClusterView | null> {
  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } })
  if (!cluster) return null
  return buildCluster(cluster, await loadClusterMembers(cluster.id))
}

/**
 * Every cluster's mesh, in name order. No page renders this any more — the mesh belongs to
 * the cluster that owns it — but the activity feed folds these executions in with the
 * Kubernetes Jobs, because "what has run?" is one question whoever ran it.
 */
export async function listReplicationOverview(): Promise<ReplicationClusterView[]> {
  const clusters = await prisma.cluster.findMany({ orderBy: { name: "asc" } })

  return Promise.all(
    clusters.map(async (cluster) => buildCluster(cluster, await loadClusterMembers(cluster.id)))
  )
}
