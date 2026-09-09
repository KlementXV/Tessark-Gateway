// TransferRequest.status is the roll-up of its targets, denormalised onto the request so the admin
// queue can filter and count without loading them (see countPendingRequests). Everything that
// moves a target's status goes back through here.
import { TransferStatus } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

/**
 * The request-level view of a set of destinations.
 *
 * A partial failure reads as FAILED: one project that didn't get the image is a problem
 * somebody has to look at, and showing SUCCEEDED because the other three worked would bury it.
 * The per-target rows carry which is which.
 */
export function aggregateTransferStatus(targets: { status: TransferStatus }[]): TransferStatus {
  if (targets.length === 0) return TransferStatus.PENDING
  if (targets.every((target) => target.status === TransferStatus.PENDING)) {
    return TransferStatus.PENDING
  }
  // Anything not yet settled — including a target still queued behind its launched siblings —
  // keeps the request in flight.
  const inFlight = targets.some(
    (target) =>
      target.status === TransferStatus.PENDING ||
      target.status === TransferStatus.APPROVED ||
      target.status === TransferStatus.RUNNING,
  )
  if (inFlight) return TransferStatus.RUNNING
  // Targets only get rejected alongside their request, so this is unreachable through
  // refreshTransferStatus — but answering SUCCEEDED for a set of rejected destinations
  // would be wrong for any caller that reaches this directly.
  if (targets.every((target) => target.status === TransferStatus.REJECTED)) {
    return TransferStatus.REJECTED
  }
  return targets.some((target) => target.status === TransferStatus.FAILED)
    ? TransferStatus.FAILED
    : TransferStatus.SUCCEEDED
}

// REJECTED is a decision about the request itself, never derived from targets — a rejected
// request has none running, and recomputing would quietly turn it back into PENDING.
export async function refreshTransferStatus(transferRequestId: string) {
  const transferRequest = await prisma.transferRequest.findUnique({
    where: { id: transferRequestId },
    include: { targets: { select: { status: true } } },
  })
  if (!transferRequest) return null
  if (transferRequest.status === TransferStatus.REJECTED) return transferRequest

  const status = aggregateTransferStatus(transferRequest.targets)
  if (status === transferRequest.status) return transferRequest

  return prisma.transferRequest.update({ where: { id: transferRequestId }, data: { status } })
}
