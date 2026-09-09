import { ClusterIdentityMode, RegistryRole } from "@/generated/prisma/client"
import { usersMissingClusterIdentity } from "@/lib/clusters/identity"
import { reconcileRegistriesInBackground } from "@/lib/clusters/reconcile"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "./check"
import { isUsable } from "./health"
import { toPublicRegistry } from "./public"
import { resolveConnection } from "./resolve"
import { recordHarborObservationInBackground } from "./version-cache"

// The registries page shows one list grouped by cluster, so both halves are loaded together
// and every Harbor is probed exactly once — grouping happens in memory afterwards rather
// than through a second pass that would double the health checks.
export async function listRegistryGroups() {
  const [clusters, registries] = await Promise.all([
    prisma.cluster.findMany({
      include: { _count: { select: { projects: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.registry.findMany({ orderBy: { name: "asc" } }),
  ])

  const members = await Promise.all(
    registries.map(async (registry) => {
      const health = await checkRegistryHealth(resolveConnection(registry))
      // The probe already asked; caching what it learned is what lets the fleet show a version
      // for a member that is momentarily down, dated rather than blank.
      recordHarborObservationInBackground(registry, health)
      return {
        ...toPublicRegistry(registry),
        health,
        pendingOperations: await prisma.pendingOperation.count({
          where: { registryId: registry.id },
        }),
      }
    })
  )

  // The app has no scheduler, so recovery is driven by whoever looks: any member that is
  // healthy again gets its queued fan-out replayed here, in the background. Failures stay in
  // the queue for the next pass, and POST /api/clusters/[id]/reconcile forces it on demand.
  reconcileRegistriesInBackground(
    members
      .filter((m) => isUsable(m.health) && m.clusterId && m.role === RegistryRole.MANAGED)
      .map((m) => m.id)
  )

  const groups = await Promise.all(
    clusters.map(async (cluster) => ({
      id: cluster.id,
      name: cluster.name,
      description: cluster.description,
      registryUrl: cluster.registryUrl,
      replicationMode: cluster.replicationMode,
      replicationCron: cluster.replicationCron,
      identityMode: cluster.identityMode,
      // Memberships this cluster's Harbors cannot be told about, because nobody has said what
      // the person is called in their directory. They are grants that exist in the Gateway and
      // nowhere else — worth a number on the page, since nothing else would ever surface them.
      unmappedMembers:
        cluster.identityMode === ClusterIdentityMode.MAPPED
          ? (await usersMissingClusterIdentity(cluster.id)).length
          : 0,
      projectCount: cluster._count.projects,
      members: members.filter((m) => m.clusterId === cluster.id),
    }))
  )

  return {
    groups,
    // A Harbor can only belong to one cluster, so these are exactly the ones the "add member"
    // picker may offer.
    unassigned: members.filter((m) => !m.clusterId),
    registries: members,
  }
}
