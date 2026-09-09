import { prisma } from "@/lib/prisma"

export class TransferLaunchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

// Serialize decisions across replicas. A lost connection releases the PostgreSQL lock;
// deterministic Kubernetes names let the next attempt recover already-created resources.
export async function withTransferLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(742021, hashtext(${id})) AS acquired`
    if (!row.acquired) throw new TransferLaunchError("Transfer is being updated; retry shortly", 409)
    return run()
  }, { timeout: 1_800_000, maxWait: 5_000 })
}
