import { prisma } from "@/lib/prisma"
import { getConfig } from "@/lib/config"
import { getHarborReplicationExecution, listHarborReplicationExecutions, triggerHarborReplication } from "@/lib/registries/harbor"
import { loadMember } from "./members"
import { errorMessage } from "./fanout"
import { executionOutcome, retryAt } from "./replication-retry"

// Caller holds the replication lock. Each tick is bounded and copies themselves run on
// Harbor; no HTTP request or database transaction waits for image bytes to finish moving.
export async function advanceCatchUps(clusterId: string): Promise<void> {
  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } })
  if (!cluster || cluster.replicationMode === "none") return
  const links = await prisma.replicationLink.findMany({ where: {
    source: { clusterId }, dest: { clusterId }, status: "ACTIVE",
    harborPolicyId: { not: null }, nextAttemptAt: { lte: new Date() },
  }, orderBy: { nextAttemptAt: "asc" }, take: 20 })
  const interval = getConfig().replicationCatchupSeconds * 1000
  for (const link of links) {
    const source = await loadMember(link.sourceRegistryId)
    if (!source) continue
    try {
      if (link.executionId !== null) {
        const execution = await getHarborReplicationExecution(source.conn, link.executionId)
        if (!execution) {
          await prisma.replicationLink.update({ where: { id: link.id }, data: {
            executionId: null, catchUpRequested: true, executionStatus: "Unknown",
            executionError: "Tracked Harbor execution no longer exists; catch-up will be retried",
            nextAttemptAt: retryAt(link.attempts), attempts: { increment: 1 },
          } })
          continue
        }
        const outcome = executionOutcome(execution.status, execution.failed)
        if (outcome === "failed") {
          await prisma.replicationLink.update({ where: { id: link.id }, data: {
            executionId: null, executionStatus: execution.status,
            executionError: `Catch-up execution ${link.executionId} ${execution.status} (${execution.failed ?? 0} failed tasks)`,
            catchUpRequested: true, attempts: { increment: 1 }, nextAttemptAt: retryAt(link.attempts),
          } })
        } else {
          await prisma.replicationLink.update({ where: { id: link.id }, data: {
            executionStatus: execution.status, executionError: null,
            nextAttemptAt: new Date(Date.now() + getConfig().replicationPollSeconds * 1000),
            ...(outcome === "succeeded" ? { executionId: null, lastCatchUpAt: new Date(), attempts: 0 } : {}),
          } })
        }
        continue
      }
      if (!link.catchUpRequested && !(interval > 0 && (!link.lastCatchUpAt || Date.now() - link.lastCatchUpAt.getTime() >= interval))) {
        await prisma.replicationLink.update({ where: { id: link.id }, data: {
          nextAttemptAt: new Date(Date.now() + getConfig().replicationPollSeconds * 1000),
        } })
        continue
      }
      // Adopt an in-flight manual execution after a crash between Harbor's POST and our DB
      // update. Event/scheduled executions do not prove a complete catch-up was requested.
      const recent = await listHarborReplicationExecutions(source.conn, 100, link.harborPolicyId!)
      const running = recent.find((run) => run.trigger === "manual" && executionOutcome(run.status, run.failed) === "running")
      const executionId = running?.id ?? await triggerHarborReplication(source.conn, link.harborPolicyId!)
      await prisma.replicationLink.update({ where: { id: link.id }, data: {
        executionId, lastExecutionId: executionId, executionStatus: "InProgress", executionError: null, catchUpRequested: false,
        nextAttemptAt: new Date(Date.now() + getConfig().replicationPollSeconds * 1000),
      } })
    } catch (err) {
      // Reading an execution failed: retain its ID instead of launching a duplicate copy.
      await prisma.replicationLink.update({ where: { id: link.id }, data: {
        executionError: errorMessage(err), attempts: { increment: 1 }, nextAttemptAt: retryAt(link.attempts),
      } })
    }
  }
}
