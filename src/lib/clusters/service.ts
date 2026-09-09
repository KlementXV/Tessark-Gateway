import { withReplicationLock } from "./replication-lock"
import { ClusterIdentityMode, RegistryRole } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "@/lib/registries/check"
import { toPublicRegistry } from "@/lib/registries/public"
import { resolveConnection } from "@/lib/registries/resolve"
import { adoptHarborProjects, inspectJoinCandidate } from "./adopt"
import { enqueue } from "./fanout"
import { usersMissingClusterIdentity } from "./identity"
import { toMember } from "./members"
import { reconcileRegistry } from "./reconcile"
import { syncClusterReplication, unlinkRegistry } from "./replication"
import type { ClusterInput } from "./schema"

export interface AddMemberOptions {
  /**
   * The operator has seen the list of projects this Harbor would bring into the mesh and wants
   * them adopted. Absent, a non-empty list is a refusal rather than a silent import.
   */
  acceptExisting?: boolean
}

export interface AddMemberResult {
  error?: string
  /** Names that exist on both sides; the join is refused and confirming cannot help. */
  colliding?: string[]
  /** Names only the candidate has; re-sending with acceptExisting adopts them. */
  incoming?: string[]
}

// Every member's health in one shot, alongside how much work is queued for it — the two
// numbers that together say whether a cluster is actually in sync.
export async function listClustersWithHealth() {
  const clusters = await prisma.cluster.findMany({
    include: {
      registries: { orderBy: { name: "asc" } },
      _count: { select: { projects: true } },
    },
    orderBy: { name: "asc" },
  })

  return Promise.all(
    clusters.map(async (cluster) => {
      const members = await Promise.all(
        cluster.registries.map(async (registry) => ({
          ...toPublicRegistry(registry),
          health: await checkRegistryHealth(resolveConnection(registry)),
          pendingOperations: await prisma.pendingOperation.count({
            where: { registryId: registry.id },
          }),
        }))
      )

      return {
        id: cluster.id,
        name: cluster.name,
        description: cluster.description,
        replicationMode: cluster.replicationMode,
        replicationCron: cluster.replicationCron,
        identityMode: cluster.identityMode,
        createdAt: cluster.createdAt,
        projectCount: cluster._count.projects,
        members,
      }
    })
  )
}

export async function loadClusterDetail(clusterId: string) {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: {
      registries: { orderBy: { name: "asc" } },
      projects: { orderBy: { createdAt: "desc" }, include: { placements: true } },
    },
  })
  if (!cluster) return null

  const members = await Promise.all(
    cluster.registries.map(async (registry) => ({
      ...toPublicRegistry(registry),
      health: await checkRegistryHealth(resolveConnection(registry)),
      pendingOperations: await prisma.pendingOperation.count({ where: { registryId: registry.id } }),
    }))
  )

  const links = await prisma.replicationLink.findMany({
    where: { sourceRegistryId: { in: cluster.registries.map((r) => r.id) } },
  })

  // `registries` is dropped in favour of `members`, which carries the same rows minus the
  // encrypted secret and plus their health.
  return {
    id: cluster.id,
    name: cluster.name,
    description: cluster.description,
    replicationMode: cluster.replicationMode,
    replicationCron: cluster.replicationCron,
    identityMode: cluster.identityMode,
    createdAt: cluster.createdAt,
    updatedAt: cluster.updatedAt,
    projects: cluster.projects,
    members,
    links,
  }
}

export function createCluster(input: ClusterInput) {
  return prisma.cluster.create({
    data: {
      name: input.name,
      description: input.description || null,
      registryUrl: input.registryUrl ?? null,
      replicationMode: input.replicationMode,
      replicationCron: input.replicationMode === "scheduled" ? input.replicationCron : null,
      identityMode: input.identityMode as ClusterIdentityMode,
    },
  })
}

// Raised when switching a populated cluster to MAPPED would strand memberships that have no
// account mapped yet. Carries the people concerned: "fill these in first" is only actionable
// with the list.
export class ClusterIdentityModeError extends Error {
  readonly users: Array<{ id: string; username: string; name: string | null }>

  constructor(users: Array<{ id: string; username: string; name: string | null }>) {
    super(
      `Map an account for these users on this cluster first: ${users
        .map((u) => u.username)
        .join(", ")}`
    )
    this.name = "ClusterIdentityModeError"
    this.users = users
  }
}

// Changing the mode or the schedule rewrites every policy in the mesh, so the update is
// followed by a replication sync rather than left to drift until the next membership change —
// but *only* when one of those two fields actually moved. Re-syncing on every edit meant
// renaming a cluster cost N×(N-1) Harbor writes for nothing.
async function runUpdateCluster(clusterId: string, input: ClusterInput) {
  const current = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: { identityMode: true, replicationMode: true, replicationCron: true },
  })

  // Going to MAPPED is only safe once every existing membership names a real account in the
  // cluster's directory: without that, the next reconcile would start refusing grants that
  // work today. The other direction only ever widens, so it needs no check.
  if (input.identityMode === ClusterIdentityMode.MAPPED) {
    if (current && current.identityMode !== ClusterIdentityMode.MAPPED) {
      const missing = await usersMissingClusterIdentity(clusterId)
      if (missing.length > 0) throw new ClusterIdentityModeError(missing)
    }
  }

  const nextCron = input.replicationMode === "scheduled" ? input.replicationCron : null
  const replicationChanged =
    !current ||
    current.replicationMode !== input.replicationMode ||
    (current.replicationCron ?? null) !== (nextCron ?? null)

  const cluster = await prisma.cluster.update({
    where: { id: clusterId },
    data: {
      name: input.name,
      description: input.description || null,
      registryUrl: input.registryUrl ?? null,
      replicationMode: input.replicationMode,
      replicationCron: nextCron,
      identityMode: input.identityMode as ClusterIdentityMode,
    },
  })
  // Forced: the trigger stored on every policy is exactly what changed, so the fingerprint
  // short-circuit must not be trusted to notice it on its own.
  if (replicationChanged) await syncClusterReplication(clusterId, { force: true })
  return cluster
}

// Deleting a cluster cascades to its projects, so it is only allowed once they are gone —
// an admin should never lose project records as a side effect of tidying up topology.
async function runDeleteCluster(clusterId: string): Promise<{ error?: string }> {
  const projectCount = await prisma.project.count({ where: { clusterId } })
  if (projectCount > 0) {
    return {
      error: `This cluster still holds ${projectCount} project(s). Delete or move them first.`,
    }
  }

  const registries = await prisma.registry.findMany({ where: { clusterId }, select: { id: true } })
  for (const registry of registries) {
    await unlinkRegistry(registry.id)
  }
  await prisma.registry.updateMany({ where: { clusterId }, data: { clusterId: null } })
  await prisma.cluster.delete({ where: { id: clusterId } })
  return {}
}

// Joining a cluster means catching up on everything already in it. Rather than a second
// code path, the backlog is pushed through the same queue the reconciler drains, then
// drained immediately — so a member that joins while healthy converges right away, and one
// that joins while down converges as soon as it recovers.
async function runAddClusterMember(
  clusterId: string,
  registryId: string,
  options: AddMemberOptions = {}
): Promise<AddMemberResult> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry) return { error: "Registry not found" }
  // Membership *is* the fan-out: joining a cluster is what makes a Harbor receive projects,
  // robots, retention and replication policies from the Gateway. A delivery registry is
  // defined by receiving none of that, so the two are mutually exclusive by construction.
  if (registry.role !== RegistryRole.MANAGED) {
    return {
      error: "This Harbor is a delivery registry — the Gateway only pushes images to it, so it cannot join a cluster.",
    }
  }
  if (registry.clusterId === clusterId) return { error: "This Harbor is already in this cluster" }
  if (registry.clusterId) {
    return { error: "This Harbor already belongs to another cluster — remove it from that one first." }
  }

  // What the mesh would do to this Harbor's existing content, decided before anything is
  // written. See inspectJoinCandidate: a collision is refused outright, incoming projects need
  // saying out loud once. Nothing is written until this passes, so a refusal leaves the
  // registry exactly as it was.
  const inspection = await inspectJoinCandidate(clusterId, toMember(registry))
  if (inspection.error) {
    return { error: `This Harbor's projects could not be listed: ${inspection.error}` }
  }
  if (inspection.colliding.length > 0) {
    return {
      error:
        `This Harbor already carries project(s) the cluster knows under the same name: ` +
        `${inspection.colliding.join(", ")}. Replication would overwrite one side with the ` +
        `other. Rename or empty them on one of the two Harbors first.`,
      colliding: inspection.colliding,
    }
  }
  if (inspection.incoming.length > 0 && !options.acceptExisting) {
    return {
      error:
        `This Harbor carries project(s) the cluster does not know: ${inspection.incoming.join(", ")}. ` +
        `Joining adopts them and replicates their content to every other member. Confirm to proceed.`,
      incoming: inspection.incoming,
    }
  }

  await prisma.registry.update({ where: { id: registryId }, data: { clusterId } })

  const projects = await prisma.project.findMany({
    where: { clusterId, status: "ACTIVE" },
    include: { retentionPolicy: true, robotAccounts: { select: { id: true } } },
  })

  for (const project of projects) {
    await enqueue({ registryId, kind: "PROJECT_CREATE", projectId: project.id })
    if (project.retentionPolicy) {
      await enqueue({ registryId, kind: "RETENTION_UPSERT", projectId: project.id })
    }
    for (const robot of project.robotAccounts) {
      await enqueue({
        registryId,
        kind: "ROBOT_CREATE",
        projectId: project.id,
        robotAccountId: robot.id,
      })
    }
  }

  await syncClusterReplication(clusterId)
  await reconcileRegistry(registryId)
  // Now that it is a member, its own projects get the rows they never had — the counterpart of
  // the backlog pushed above, and what makes `incoming` an accepted decision rather than a
  // warning nobody acted on.
  if (inspection.incoming.length > 0) await adoptHarborProjects(clusterId)
  return {}
}

// Leaving is deliberately non-destructive on the Harbor side: its projects, robots and
// images stay exactly where they are, matching how deleting a registry never touches its
// contents. Only the Gateway's bookkeeping and the replication mesh are unwound.
async function runRemoveClusterMember(
  clusterId: string,
  registryId: string
): Promise<{ error?: string }> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry || registry.clusterId !== clusterId) {
    return { error: "This Harbor is not a member of this cluster" }
  }

  await unlinkRegistry(registryId)
  await prisma.pendingOperation.deleteMany({ where: { registryId } })
  await prisma.projectPlacement.deleteMany({ where: { registryId } })
  await prisma.robotPlacement.deleteMany({ where: { registryId } })
  await prisma.registry.update({ where: { id: registryId }, data: { clusterId: null } })
  await syncClusterReplication(clusterId)
  return {}
}

export async function updateCluster(...args: Parameters<typeof runUpdateCluster>) {
  return withReplicationLock(() => runUpdateCluster(...args))
}

export async function deleteCluster(...args: Parameters<typeof runDeleteCluster>) {
  return withReplicationLock(() => runDeleteCluster(...args))
}

export async function addClusterMember(...args: Parameters<typeof runAddClusterMember>) {
  return withReplicationLock(() => runAddClusterMember(...args))
}

export async function removeClusterMember(...args: Parameters<typeof runRemoveClusterMember>) {
  return withReplicationLock(() => runRemoveClusterMember(...args))
}
