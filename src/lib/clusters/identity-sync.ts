import { ClusterIdentityMode } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { deleteClusterIdentity, setClusterIdentity } from "./identity"
import { removeMemberAcrossCluster, syncMemberAcrossCluster } from "./project-members"

// Changing what somebody is called on a cluster is a change of *desired state*, not a piece of
// bookkeeping: the grants already sitting on the Harbors name the old account. So a change is
// applied the only way that leaves Harbor consistent — revoke under the old name on every
// project of the cluster, then grant under the new one, through the same fan-out the member
// routes use. Skipping the revocation would leave an orphan grant on every member with
// nothing in the Gateway pointing at it.

export interface IdentityChangeResult {
  /** Projects of this cluster the user holds a membership on. */
  projects: number
  revoked: { succeeded: number; failed: number }
  granted: { succeeded: number; failed: number }
  failures: Array<{ registry: string; error: string }>
}

async function projectIdsFor(userId: string, clusterId: string): Promise<string[]> {
  const memberships = await prisma.projectMember.findMany({
    where: { userId, project: { clusterId } },
    select: { projectId: true },
  })
  return memberships.map((m) => m.projectId)
}

async function revokeEverywhere(
  projectIds: string[],
  userId: string,
  harborUsername: string,
  result: IdentityChangeResult
): Promise<void> {
  for (const projectId of projectIds) {
    const summary = await removeMemberAcrossCluster(projectId, userId, harborUsername)
    result.revoked.succeeded += summary.succeeded
    result.revoked.failed += summary.failed
    result.failures.push(...summary.failures)
  }
}

/**
 * Writes the mapping and moves the grants that follow from it.
 *
 * Throws {@link ClusterIdentityConflictError} when the account already belongs to somebody
 * else on this cluster — checked before anything is revoked, so a rejected change leaves
 * Harbor untouched.
 */
export async function applyClusterIdentityChange(
  userId: string,
  clusterId: string,
  harborUsername: string
): Promise<IdentityChangeResult> {
  const result: IdentityChangeResult = {
    projects: 0,
    revoked: { succeeded: 0, failed: 0 },
    granted: { succeeded: 0, failed: 0 },
    failures: [],
  }

  const { previous } = await setClusterIdentity(userId, clusterId, harborUsername)
  const projectIds = await projectIdsFor(userId, clusterId)
  result.projects = projectIds.length
  if (projectIds.length === 0) return result

  // Nothing to revoke when the name is unchanged, or when the mapping is being filled in for
  // a cluster that was still resolving through User.username: in the latter case the old
  // grants were pushed under that name, so they are revoked under it.
  //
  // That fallback is only legitimate on a GATEWAY cluster. On a MAPPED one an unmapped user
  // never had a grant pushed at all — resolveHarborUsername returns null and
  // loadMemberDesiredState refuses — so there is nothing of ours to revoke, and revoking under
  // User.username would name whoever *that* string happens to be in the cluster's own
  // directory. Stripping a stranger's access is the homonym failure this whole feature exists
  // to prevent, only pointing the other way. Reachable through revoke-then-remap:
  // revokeClusterIdentity() deliberately keeps the memberships.
  if (previous !== harborUsername) {
    const stale = previous ?? (await gatewayFallbackUsername(userId, clusterId))
    if (stale && stale !== harborUsername) {
      await revokeEverywhere(projectIds, userId, stale, result)
    }
  }

  for (const projectId of projectIds) {
    const summary = await syncMemberAcrossCluster(projectId, userId)
    result.granted.succeeded += summary.succeeded
    result.granted.failed += summary.failed
    result.failures.push(...summary.failures)
  }

  return result
}

/**
 * Drops the mapping and revokes every grant it produced on this cluster. The memberships
 * themselves stay: what the Gateway lists is unchanged, only the Harbor-side grants go — the
 * user has no account there any more, so no grant can name them.
 */
export async function revokeClusterIdentity(
  userId: string,
  clusterId: string
): Promise<IdentityChangeResult> {
  const result: IdentityChangeResult = {
    projects: 0,
    revoked: { succeeded: 0, failed: 0 },
    granted: { succeeded: 0, failed: 0 },
    failures: [],
  }

  const { previous } = await deleteClusterIdentity(userId, clusterId)
  if (!previous) return result

  const projectIds = await projectIdsFor(userId, clusterId)
  result.projects = projectIds.length
  await revokeEverywhere(projectIds, userId, previous, result)
  return result
}

/**
 * The name a grant would have been pushed under when no mapping existed — which is
 * `User.username`, and only on a cluster that resolves that way. Null on a MAPPED cluster:
 * see the caller.
 */
async function gatewayFallbackUsername(userId: string, clusterId: string): Promise<string | null> {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: { identityMode: true },
  })
  if (!cluster || cluster.identityMode === ClusterIdentityMode.MAPPED) return null

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  return user?.username ?? null
}
