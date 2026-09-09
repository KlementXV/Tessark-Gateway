import { formatQuotaMib } from "@/lib/projects/quota"
import { prisma } from "@/lib/prisma"
import { describeDestination, destinationHref } from "@/lib/transfers/destination"

export type RequestKind = "PROJECT" | "TRANSFER" | "QUOTA" | "PROJECT_DELETE"

export type RequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "ACTIVE"

// One row of the admin Requests surface. Project creations and image transfers are two different
// models with two different approval endpoints, but from an admin's point of view they are
// the same queue — so both are flattened into this shape and merged into a single list.
export interface RequestItem {
  id: string
  kind: RequestKind
  title: string
  subtitle: string
  status: RequestStatus
  /** Display name of the requester; null when the account no longer exists (the UI labels it). */
  requestedBy: string | null
  reviewedBy: string | null
  reason: string | null
  createdAt: string
  updatedAt: string
  href: string
  /**
   * True when at least one destination is a Harbor the Gateway does not administer.
   *
   * A reviewer approving this is not moving an image between projects they own — they are
   * sending it somewhere else entirely, possibly out of the network. That is a different kind
   * of decision, and it has to be visible without opening the request.
   */
  leavesEstate?: boolean
  /**
   * The paste this transfer came out of, when several images were asked for in one gesture.
   *
   * The rows stay independent — one approval, one status, one retry each — so this is purely
   * how the queue is *read*: fourteen rows a requester submitted together are shown as one
   * group, and a reviewer approves the subset they agree with rather than fourteen rows one at
   * a time or, worse, all of them because they came together.
   */
  batchId?: string | null
}

function displayName(user: { name: string | null; email: string } | undefined): string | null {
  if (!user) return null
  return user.name?.trim() || user.email
}

// `pending` splits the admin queue in two — what still awaits a review from what has already
// been decided; `userId` narrows the whole thing to one requester, which is what a user sees
// of their own requests. Every caller goes through the same flattening.
async function loadRequests({
  pending,
  userId,
}: {
  pending?: boolean
  userId?: string
}): Promise<RequestItem[]> {
  const status =
    pending === undefined ? undefined : pending ? { status: "PENDING" as const } : { status: { not: "PENDING" as const } }

  const [projects, transfers, quotas, deletions] = await Promise.all([
    prisma.project.findMany({
      // An adopted project has no requester — it was never asked for, so it has no place in
      // a queue of requests.
      where: { ...status, ownerUserId: userId ?? { not: null } },
      include: { cluster: { select: { name: true } } },
    }),
    prisma.transferRequest.findMany({
      where: { ...status, ...(userId ? { requestedByUserId: userId } : {}) },
      include: {
        targets: {
          include: {
            project: { select: { id: true, name: true } },
            destRegistry: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
    prisma.quotaRequest.findMany({
      where: { ...status, ...(userId ? { requestedByUserId: userId } : {}) },
      include: { project: { select: { id: true, name: true } } },
    }),
    // No `include` on the project: an approved deletion request outlives the project it
    // destroyed (SetNull), and `projectName` is what it still names afterwards.
    prisma.projectDeleteRequest.findMany({
      where: { ...status, ...(userId ? { requestedByUserId: userId } : {}) },
    }),
  ])

  // Requester and reviewer are plain id columns (no FK to User), so they're resolved in one
  // extra round-trip rather than through an include.
  const userIds = new Set<string>()
  for (const project of projects) if (project.ownerUserId) userIds.add(project.ownerUserId)
  for (const transfer of transfers) {
    userIds.add(transfer.requestedByUserId)
    if (transfer.reviewedByUserId) userIds.add(transfer.reviewedByUserId)
  }
  for (const quota of quotas) {
    userIds.add(quota.requestedByUserId)
    if (quota.reviewedByUserId) userIds.add(quota.reviewedByUserId)
  }
  for (const deletion of deletions) {
    userIds.add(deletion.requestedByUserId)
    if (deletion.reviewedByUserId) userIds.add(deletion.reviewedByUserId)
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, name: true, email: true },
  })
  const byId = new Map(users.map((user) => [user.id, user]))

  const items: RequestItem[] = [
    ...projects.map<RequestItem>((project) => ({
      id: project.id,
      kind: "PROJECT",
      title: project.name,
      subtitle: project.description
        ? `${project.cluster.name} · ${project.description}`
        : project.cluster.name,
      status: project.status,
      requestedBy: displayName(project.ownerUserId ? byId.get(project.ownerUserId) : undefined),
      reviewedBy: null,
      reason: project.rejectionReason,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      href: `/projects/${project.id}`,
    })),
    ...transfers.map<RequestItem>((transfer) => ({
      id: transfer.id,
      kind: "TRANSFER",
      title: transfer.sourceImage,
      // Where it lands, named destination by destination — a reviewer approving one request
      // is approving all of them at once, so the queue has to show the whole blast radius.
      subtitle: transfer.targets.map(describeDestination).join(", "),
      status: transfer.status,
      requestedBy: displayName(byId.get(transfer.requestedByUserId)),
      reviewedBy: transfer.reviewedByUserId ? displayName(byId.get(transfer.reviewedByUserId)) : null,
      // A rejection explains the request; otherwise the first destination that failed is the
      // one worth surfacing here, with the rest visible on the project's Transfers tab.
      reason:
        transfer.rejectionReason ??
        transfer.targets.find((target) => target.errorMessage)?.errorMessage ??
        null,
      createdAt: transfer.createdAt.toISOString(),
      updatedAt: transfer.updatedAt.toISOString(),
      href: (transfer.targets[0] && destinationHref(transfer.targets[0])) ?? "/requests",
      leavesEstate: transfer.targets.some((target) => target.destRegistryId !== null),
      batchId: transfer.batchId,
    })),
    ...quotas.map<RequestItem>((quota) => ({
      id: quota.id,
      kind: "QUOTA",
      title: quota.project.name,
      // The before/after is the whole request — `currentQuotaMib` is the snapshot taken when
      // it was raised, so this keeps reading correctly once the quota has moved on.
      subtitle: `${formatQuotaMib(quota.currentQuotaMib)} → ${formatQuotaMib(quota.requestedQuotaMib)}`,
      status: quota.status,
      requestedBy: displayName(byId.get(quota.requestedByUserId)),
      reviewedBy: quota.reviewedByUserId ? displayName(byId.get(quota.reviewedByUserId)) : null,
      // The requester's justification is what a reviewer needs while it is pending; once
      // rejected, the reviewer's own reason replaces it.
      reason: quota.rejectionReason ?? quota.reason,
      createdAt: quota.createdAt.toISOString(),
      updatedAt: quota.updatedAt.toISOString(),
      href: `/projects/${quota.projectId}?tab=quota`,
    })),
    ...deletions.map<RequestItem>((deletion) => ({
      id: deletion.id,
      kind: "PROJECT_DELETE",
      title: deletion.projectName,
      // What the reviewer is actually being asked. A deletion has no before/after to show, so
      // the requester's reason is the subtitle: it is the whole of what they have to go on.
      subtitle: deletion.reason ?? "",
      status: deletion.status,
      requestedBy: displayName(byId.get(deletion.requestedByUserId)),
      reviewedBy: deletion.reviewedByUserId ? displayName(byId.get(deletion.reviewedByUserId)) : null,
      // Once refused, the reviewer's own reason replaces the requester's — same rule as a
      // quota request.
      reason: deletion.rejectionReason ?? deletion.reason,
      createdAt: deletion.createdAt.toISOString(),
      updatedAt: deletion.updatedAt.toISOString(),
      // An approved one has no project page left to link to.
      href: deletion.projectId ? `/projects/${deletion.projectId}` : "/requests",
    })),
  ]

  // Oldest first in the review queue — it is worked from the top — most recent first
  // everywhere else.
  return pending === true
    ? items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// Drives the sidebar badge — a count only, so it stays cheap enough to run on every render
// of the shell.
export async function countPendingRequests() {
  const [projects, transfers, quotas, deletions] = await Promise.all([
    prisma.project.count({ where: { status: "PENDING" } }),
    prisma.transferRequest.count({ where: { status: "PENDING" } }),
    prisma.quotaRequest.count({ where: { status: "PENDING" } }),
    prisma.projectDeleteRequest.count({ where: { status: "PENDING" } }),
  ])
  return projects + transfers + quotas + deletions
}

export function listPendingRequests() {
  return loadRequests({ pending: true })
}

export function listReviewedRequests() {
  return loadRequests({ pending: false })
}

// What one user raised themselves, whatever its state — the "My requests" tab under Projects.
export function listRequestsForUser(userId: string) {
  return loadRequests({ userId })
}
