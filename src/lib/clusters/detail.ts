import { ClusterIdentityMode } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "@/lib/registries/check"
import { toPublicRegistry } from "@/lib/registries/public"
import { resolveConnection } from "@/lib/registries/resolve"
import { usersMissingClusterIdentity } from "./identity"

// One cluster, as its own page needs it. The fleet list (listRegistryGroups) answers the same
// questions for every cluster at once and probes every Harbor to do it; this probes only the
// members of the one being opened, which is what makes a drill-in cheaper than the list it
// was reached from rather than more expensive.
export async function getClusterDetail(id: string) {
  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { _count: { select: { projects: true } } },
  })
  if (!cluster) return null

  const registries = await prisma.registry.findMany({
    where: { clusterId: id },
    orderBy: { name: "asc" },
  })

  const members = await Promise.all(
    registries.map(async (registry) => ({
      ...toPublicRegistry(registry),
      health: await checkRegistryHealth(resolveConnection(registry)),
      pendingOperations: await prisma.pendingOperation.count({ where: { registryId: registry.id } }),
    })),
  )

  return {
    cluster,
    members,
    projectCount: cluster._count.projects,
    // Memberships this cluster's Harbors cannot be told about, because nobody has said what
    // the person is called in its directory. Grants that exist in the Gateway and nowhere
    // else — worth a number on the page, since nothing else would ever surface them.
    unmappedMembers:
      cluster.identityMode === ClusterIdentityMode.MAPPED
        ? (await usersMissingClusterIdentity(id)).length
        : 0,
  }
}
