import { prisma } from "@/lib/prisma"
import { decryptSecret } from "@/lib/crypto"
import { logger } from "@/lib/logger"
import { harborObjectMatches, deleteHarborRegistryEndpoint, deleteHarborReplicationPolicy, disableHarborReplicationPolicy } from "@/lib/registries/harbor"
import type { RegistryConnection } from "@/lib/registries/types"
import { loadMember } from "./members"
import { errorMessage } from "./fanout"
import { retryAt } from "./replication-retry"

// Called under the replication lock. Never forget the external objects on a failed step.
export async function drainReplicationCleanup(id?: string): Promise<void> {
  const rows = await prisma.replicationCleanup.findMany({
    where: id ? { id } : { nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: 50,
  })
  for (const row of rows) {
    try {
      // Use rotated credentials while the source still exists; retain the original address
      // because a changed Registry URL may now designate an entirely different Harbor.
      const saved = JSON.parse(decryptSecret(row.encryptedConnection)) as RegistryConnection
      const member = await loadMember(row.sourceRegistryId)
      const conn = member?.conn.baseUrl === saved.baseUrl ? member.conn : saved
      if (row.harborPolicyId !== null) {
        if (await harborObjectMatches(conn, `/api/v2.0/replication/policies/${row.harborPolicyId}`, `tessark-replicate-${row.destRegistryId}`)) {
          await disableHarborReplicationPolicy(conn, row.harborPolicyId)
          await deleteHarborReplicationPolicy(conn, row.harborPolicyId)
        }
        await prisma.replicationCleanup.update({ where: { id: row.id }, data: { harborPolicyId: null } })
      }
      if (row.harborEndpointId !== null && await harborObjectMatches(conn, `/api/v2.0/registries/${row.harborEndpointId}`, `tessark-peer-${row.destRegistryId}`)) {
        await deleteHarborRegistryEndpoint(conn, row.harborEndpointId)
      }
      await prisma.replicationCleanup.delete({ where: { id: row.id } })
    } catch (err) {
      const error = errorMessage(err)
      await prisma.replicationCleanup.update({ where: { id: row.id }, data: {
        attempts: { increment: 1 }, nextAttemptAt: retryAt(row.attempts), lastError: error,
      } })
      logger.warn("Replication cleanup pending", { cleanupId: row.id, error })
    }
  }
}
