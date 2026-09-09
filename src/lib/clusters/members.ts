import { RegistryRole, type Registry } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "@/lib/registries/check"
import { isUsable } from "@/lib/registries/health"
import { resolveConnection } from "@/lib/registries/resolve"
import type { RegistryConnection } from "@/lib/registries/types"

// A single Harbor the Gateway drives, with its credentials already decrypted. Server-only:
// `conn` carries a plaintext secret and must never cross to the client.
//
// `role` rides along so that every consumer can tell a Harbor we own from one we only deliver
// to without a second query. Everything that fans out — creating projects, aligning robots,
// posting retention, weaving the replication mesh — must refuse a DELIVERY member: those
// objects belong to whoever runs that Harbor, and writing them would be the Gateway
// administering a registry it was never given.
export interface ClusterMember {
  registryId: string
  registryName: string
  role: RegistryRole
  conn: RegistryConnection
}

export function toMember(registry: Registry): ClusterMember {
  return {
    registryId: registry.id,
    registryName: registry.name,
    role: registry.role,
    conn: resolveConnection(registry),
  }
}

// Thrown when a fan-out path is handed a Harbor the Gateway does not administer. It is a
// programming error rather than a user-facing condition — the callers upstream are supposed
// to have filtered already — so it carries no HTTP status.
export class NotManagedError extends Error {
  constructor(registryName: string) {
    super(`${registryName} is a delivery registry: the Gateway never writes projects, robots or policies there.`)
  }
}

export function assertManaged(member: ClusterMember): void {
  if (member.role !== RegistryRole.MANAGED) throw new NotManagedError(member.registryName)
}

// Ordered by name so fan-out results, placement lists and the UI all agree on member order.
// Filtered on MANAGED as a belt to addClusterMember's braces: a DELIVERY registry cannot join
// a cluster in the first place, and if one ever did, every caller of this function would start
// writing to a Harbor it does not own.
export async function loadClusterMembers(clusterId: string): Promise<ClusterMember[]> {
  const registries = await prisma.registry.findMany({
    where: { clusterId, role: RegistryRole.MANAGED },
    orderBy: { name: "asc" },
  })
  return registries.map(toMember)
}

export async function loadMember(registryId: string): Promise<ClusterMember | null> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  return registry ? toMember(registry) : null
}

// Any member that answers right now, project-independent — for the reads that concern the
// cluster as a whole rather than one project, such as searching its user directory. Members
// are tried in name order so two calls in a row hit the same Harbor while it stays healthy.
export async function pickHealthyMember(clusterId: string): Promise<ClusterMember | null> {
  for (const member of await loadClusterMembers(clusterId)) {
    const health = await checkRegistryHealth(member.conn)
    if (isUsable(health)) return member
  }
  return null
}

// Picks one member to write a project's images to. In a mesh any healthy member will do —
// whatever lands there is replicated to the rest — so this only has to find one that is up
// and actually hosts the project. Members are tried in name order, and the health probe is
// what makes this useful: writing to a member that is down would fail the whole job when a
// perfectly good peer was available.
export async function pickWriteMember(
  clusterId: string,
  projectId: string
): Promise<ClusterMember | null> {
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, status: "ACTIVE", harborProjectId: { not: null } },
    include: { registry: true },
  })

  const candidates = placements
    .filter(
      (placement) =>
        placement.registry.clusterId === clusterId &&
        placement.registry.role === RegistryRole.MANAGED,
    )
    .sort((a, b) => a.registry.name.localeCompare(b.registry.name))

  for (const placement of candidates) {
    const member = toMember(placement.registry)
    const health = await checkRegistryHealth(member.conn)
    if (isUsable(health)) return member
  }

  return null
}
