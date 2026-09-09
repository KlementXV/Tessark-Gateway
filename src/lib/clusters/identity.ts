import { ClusterIdentityMode, Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

// Turning a Gateway user into the name their Harbors know them by.
//
// With one directory behind everything, the two are the same string and this module is a
// pass-through — that is `ClusterIdentityMode.GATEWAY`, and it stays the default. A cluster
// backed by its own directory (`MAPPED`) needs the mapping to be explicit: the account named
// `clement` over there may be absent, or may be somebody else entirely. Harbor answers 404
// for the first case, which is loud; the second is silent, which is why nothing here ever
// falls back to `User.username`.

export class MissingClusterIdentityError extends Error {
  readonly userId: string
  readonly clusterId: string

  constructor(userId: string, clusterId: string, clusterName?: string) {
    super(
      clusterName
        ? `No account mapped on "${clusterName}" for this user`
        : `No account mapped on this cluster for user ${userId}`
    )
    this.name = "MissingClusterIdentityError"
    this.userId = userId
    this.clusterId = clusterId
  }
}

/**
 * The name `userId` goes by on `clusterId`'s Harbors, or null when the cluster is MAPPED and
 * no mapping exists. Callers turn that null into a refusal — never into `User.username`.
 */
export async function resolveHarborUsername(
  userId: string,
  clusterId: string
): Promise<string | null> {
  const [cluster, identity] = await Promise.all([
    prisma.cluster.findUnique({ where: { id: clusterId }, select: { identityMode: true } }),
    prisma.userClusterIdentity.findUnique({
      where: { userId_clusterId: { userId, clusterId } },
      select: { harborUsername: true },
    }),
  ])
  if (!cluster) return null

  // A mapping is honoured even in GATEWAY mode: an operator who filled one in before
  // switching modes, or who switched back, meant it.
  if (identity) return identity.harborUsername
  if (cluster.identityMode === ClusterIdentityMode.MAPPED) return null

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  return user?.username ?? null
}

/**
 * Same resolution for a batch of users — one pass over the cluster rather than one query per
 * membership. Users with no resolvable name are simply absent from the map.
 */
export async function resolveHarborUsernames(
  userIds: string[],
  clusterId: string
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  if (userIds.length === 0) return resolved

  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: { identityMode: true },
  })
  if (!cluster) return resolved

  const identities = await prisma.userClusterIdentity.findMany({
    where: { clusterId, userId: { in: userIds } },
    select: { userId: true, harborUsername: true },
  })
  for (const identity of identities) resolved.set(identity.userId, identity.harborUsername)

  if (cluster.identityMode === ClusterIdentityMode.MAPPED) return resolved

  const unmapped = userIds.filter((id) => !resolved.has(id))
  if (unmapped.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: unmapped } },
      select: { id: true, username: true },
    })
    for (const user of users) resolved.set(user.id, user.username)
  }
  return resolved
}

export function listClusterIdentities(clusterId: string) {
  return prisma.userClusterIdentity.findMany({
    where: { clusterId },
    include: { user: { select: { id: true, username: true, name: true, email: true } } },
    orderBy: { harborUsername: "asc" },
  })
}

export function getClusterIdentity(userId: string, clusterId: string) {
  return prisma.userClusterIdentity.findUnique({
    where: { userId_clusterId: { userId, clusterId } },
  })
}

export class ClusterIdentityConflictError extends Error {
  constructor(harborUsername: string) {
    super(`The account "${harborUsername}" is already mapped to another user on this cluster`)
    this.name = "ClusterIdentityConflictError"
  }
}

/**
 * Writes the mapping, refusing an account already taken by somebody else on the same cluster.
 * The comparison is case-insensitive because Harbor's own member matching is (see
 * findHarborProjectMember), so `Clement` and `clement` are one account, not two.
 *
 * Returns the name previously mapped, if any — the caller needs it to revoke the old grants
 * before the new ones are pushed (see applyClusterIdentityChange).
 */
export async function setClusterIdentity(
  userId: string,
  clusterId: string,
  harborUsername: string
): Promise<{ previous: string | null }> {
  const taken = await prisma.userClusterIdentity.findFirst({
    where: {
      clusterId,
      userId: { not: userId },
      harborUsername: { equals: harborUsername, mode: "insensitive" },
    },
    select: { id: true },
  })
  if (taken) throw new ClusterIdentityConflictError(harborUsername)

  const existing = await getClusterIdentity(userId, clusterId)
  try {
    await prisma.userClusterIdentity.upsert({
      where: { userId_clusterId: { userId, clusterId } },
      create: { userId, clusterId, harborUsername },
      update: { harborUsername },
    })
  } catch (err) {
    // @@unique([clusterId, harborUsername]) is the backstop for two admins mapping the same
    // account at once, which the read above cannot see. Reported as the conflict it is rather
    // than as a raw constraint failure — same answer either way, and the caller already knows
    // how to render it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ClusterIdentityConflictError(harborUsername)
    }
    throw err
  }
  return { previous: existing?.harborUsername ?? null }
}

export async function deleteClusterIdentity(
  userId: string,
  clusterId: string
): Promise<{ previous: string | null }> {
  const existing = await getClusterIdentity(userId, clusterId)
  if (!existing) return { previous: null }
  await prisma.userClusterIdentity.delete({ where: { id: existing.id } })
  return { previous: existing.harborUsername }
}

/**
 * The people who hold a membership on one of the cluster's projects but have no mapping —
 * exactly the set that would start failing the moment the cluster is switched to MAPPED, so
 * the switch is refused until it is empty.
 */
export async function usersMissingClusterIdentity(clusterId: string) {
  const memberships = await prisma.projectMember.findMany({
    where: { project: { clusterId } },
    select: { userId: true },
    distinct: ["userId"],
  })
  return usersMissingIdentityAmong(clusterId, memberships.map((m) => m.userId))
}

/**
 * The same question asked about a set of people who are not (yet) members of anything in this
 * cluster — which is what moving a project into it needs to know *before* the move, while the
 * project still belongs somewhere else and usersMissingClusterIdentity() would not see it.
 */
export async function usersMissingIdentityAmong(clusterId: string, candidateIds: string[]) {
  const userIds = [...new Set(candidateIds)]
  if (userIds.length === 0) return []

  const mapped = await prisma.userClusterIdentity.findMany({
    where: { clusterId, userId: { in: userIds } },
    select: { userId: true },
  })
  const mappedIds = new Set(mapped.map((m) => m.userId))

  return prisma.user.findMany({
    where: { id: { in: userIds.filter((id) => !mappedIds.has(id)) } },
    select: { id: true, username: true, name: true },
    orderBy: { username: "asc" },
  })
}
