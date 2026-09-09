import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/logger"
import { withReplicationLock } from "./replication-lock"
import { drainReplicationCleanup } from "./replication-cleanup"
import { advanceCatchUps } from "./replication-catchup"
import { syncClusterReplication } from "./replication"
import { reconcileRegistry } from "./reconcile"
import { errorMessage } from "./fanout"

export async function replicationTick(): Promise<void> {
  await withReplicationLock(() => drainReplicationCleanup())
  const clusters = await prisma.cluster.findMany({ select: { id: true }, orderBy: { id: "asc" } })
  for (const cluster of clusters) {
    try {
      // Each unit releases the lock, leaving room for operator actions between ticks.
      const members = await prisma.registry.findMany({ where: { clusterId: cluster.id, role: "MANAGED" }, select: { id: true } })
      for (const member of members) await reconcileRegistry(member.id, true)
      await syncClusterReplication(cluster.id)
      await withReplicationLock(() => advanceCatchUps(cluster.id))
    } catch (err) {
      logger.warn("Replication maintenance deferred", { clusterId: cluster.id, error: errorMessage(err) })
    }
  }
}

const state = globalThis as typeof globalThis & { replicationWorkerStarted?: boolean }
export function startReplicationWorker(): void {
  const config = getConfig()
  if (!config.replicationWorkerEnabled || state.replicationWorkerStarted) return
  state.replicationWorkerStarted = true
  const tick = async () => {
    try { await replicationTick() }
    catch (err) { logger.warn("Replication worker tick failed", { error: errorMessage(err) }) }
    // Recursive timeout: a slow pass never overlaps its successor in the same process.
    setTimeout(tick, config.replicationPollSeconds * 1000).unref()
  }
  setTimeout(tick, 1000).unref()
}
