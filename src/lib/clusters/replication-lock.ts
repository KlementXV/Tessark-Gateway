import { AsyncLocalStorage } from "node:async_hooks"
import { prisma } from "@/lib/prisma"

const ownership = new AsyncLocalStorage<boolean>()

// A transaction-scoped PostgreSQL lock is released on connection loss, including a killed
// pod. Try-lock avoids occupying the connection pool with callers waiting behind a worker.
// Reentrant because membership changes call sync/unlink and reconcile calls sync/catch-up.
export async function withReplicationLock<T>(run: () => Promise<T>): Promise<T> {
  if (ownership.getStore()) return run()
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(742019, 1) AS acquired`
    if (!row.acquired) throw new Error("Replication maintenance is already running; retry shortly")
    return ownership.run(true, run)
  }, { timeout: 1_800_000, maxWait: 5_000 })
}
