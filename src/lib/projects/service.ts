import type { Session } from "next-auth"

import { ProjectMemberRole, RegistryRole, Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"
import { prisma } from "@/lib/prisma"
import { listHarborProjects } from "@/lib/registries/harbor"
import { resolveConnection } from "@/lib/registries/resolve"

/**
 * One place an image can be sent, in the two forms a TransferTarget takes.
 *
 * `id` is what the dialog keys its selection on, so it identifies the *coordinate*: a project
 * id for a managed destination, "<registryId>:<projectName>" for a delivery one, because the
 * same project name exists on several Harbors and a bare name would collide.
 */
export interface TransferSourceRegistry {
  id: string
  name: string
  host: string
  projects: string[]
}

export type TransferDestination =
  | { kind: "project"; id: string; name: string; isPublic: boolean }
  | {
      kind: "delivery"
      id: string
      name: string
      isPublic: boolean
      registryId: string
      registryName: string
    }

// What a signed-in user can see: the projects they belong to, plus every public one — the
// same rule Harbor applies to its own project list. Admins and superadmins see every project
// on the instance instead, membership or not. Only approved projects show up either way: a
// request that is still pending, or was rejected, lives in the requester's "My requests" tab
// and in Admin › Requests, not here.
export function listProjectsForSession(session: Session) {
  const isAdmin = hasRole(session, Role.ADMIN)

  return prisma.project.findMany({
    where: {
      status: "ACTIVE",
      ...(isAdmin
        ? {}
        : {
            OR: [
              { isPublic: true },
              { ownerUserId: session.user.id },
              { members: { some: { userId: session.user.id } } },
            ],
          }),
    },
    include: {
      cluster: {
        select: {
          name: true,
          _count: { select: { registries: true } },
        },
      },
      // Enough to show "3/4 Harbors in sync" in the list without a second round trip.
      placements: { select: { status: true } },
    },
    orderBy: { createdAt: "desc" },
  })
}

// Where the signed-in user may ask for an image to be mirrored. Narrower than what they can
// see: this must agree exactly with validateTransferRequest, or the picker offers destinations the
// API then refuses. Standing to write is what counts — a GUEST, and a non-member looking at a
// public project, have read access and no more. Only id and name — this fills a checkbox list,
// not a page.
/**
 * Every place this user may send an image to.
 *
 * Two kinds, in one list because the dialog offers them as one list: the Gateway projects they
 * can write into, and the projects of each delivery registry. The second kind is read live
 * from the remote Harbor — the Gateway keeps no copy of a project list it does not own, and a
 * stale one would offer a destination that no longer exists.
 *
 * The rules are *not* applied here. This is what is addressable; whether a given pairing of
 * source and destination is permitted depends on the source, which is only chosen inside the
 * dialog — so the policy is enforced where it can be, in validateTransferRequest.
 */
export async function listTransferDestinations(session: Session): Promise<TransferDestination[]> {
  const isAdmin = hasRole(session, Role.ADMIN)

  const projects = await prisma.project.findMany({
    where: {
      status: "ACTIVE",
      ...(isAdmin
        ? {}
        : {
            OR: [
              { ownerUserId: session.user.id },
              {
                members: {
                  some: { userId: session.user.id, role: { not: ProjectMemberRole.GUEST } },
                },
              },
            ],
          }),
    },
    select: { id: true, name: true, isPublic: true },
    orderBy: { name: "asc" },
  })

  const managed: TransferDestination[] = projects.map((project) => ({
    kind: "project",
    id: project.id,
    name: project.name,
    isPublic: project.isPublic,
  }))

  // Delivering outside the estate is an admin action: there is no Gateway-side membership to
  // consult on a Harbor we do not administer, so there is nothing to grant a plain user on it.
  if (!isAdmin) return managed

  const deliveries = await prisma.registry.findMany({
    where: { role: RegistryRole.DELIVERY },
    orderBy: { name: "asc" },
  })

  const remote = await Promise.all(
    deliveries.map(async (registry) => {
      try {
        const harborProjects = await listHarborProjects(resolveConnection(registry))
        return harborProjects.map<TransferDestination>((project) => ({
          kind: "delivery",
          // Composite because the same project name exists on several Harbors: the id has to
          // identify the coordinate, not the project.
          id: `${registry.id}:${project.name}`,
          name: project.name,
          isPublic: project.isPublic,
          registryId: registry.id,
          registryName: registry.name,
        }))
      } catch {
        // A registry that is down simply offers nothing. Failing the whole page over it would
        // take the managed destinations down with it, which is a worse trade.
        return []
      }
    }),
  )

  return [...managed, ...remote.flat()]
}

// Projects target a cluster, never an individual Harbor — a lone Harbor is a cluster of one.
// An empty cluster has nothing to create the project on, so it isn't offered.
export async function listProjectTargets() {
  const clusters = await prisma.cluster.findMany({
    include: { _count: { select: { registries: true } } },
    orderBy: { name: "asc" },
  })
  return clusters
    .filter((cluster) => cluster._count.registries > 0)
    .map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      memberCount: cluster._count.registries,
    }))
}

/**
 * The Harbors a requester may take an image *out of*, with their project lists.
 *
 * Admin-only, for the same reason delivery destinations are: reading a Harbor's contents
 * through the Gateway's stored credential is not something a project membership grants, and a
 * delivery registry has no Gateway-side membership at all. Non-admins keep the upstream-source
 * form, which is exactly what they had before.
 *
 * A registry that cannot be reached contributes nothing rather than failing the page — the
 * same trade as listTransferDestinations.
 */
export async function listTransferSourceRegistries(
  session: Session,
): Promise<TransferSourceRegistry[]> {
  if (!hasRole(session, Role.ADMIN)) return []

  const registries = await prisma.registry.findMany({ orderBy: { name: "asc" } })

  const resolved = await Promise.all(
    registries.map(async (registry) => {
      const conn = resolveConnection(registry)
      try {
        const projects = await listHarborProjects(conn)
        if (projects.length === 0) return null
        return {
          id: registry.id,
          name: registry.name,
          host: new URL(conn.baseUrl).host,
          projects: projects.map((project) => project.name),
        }
      } catch {
        return null
      }
    }),
  )

  return resolved.filter((registry): registry is TransferSourceRegistry => registry !== null)
}
