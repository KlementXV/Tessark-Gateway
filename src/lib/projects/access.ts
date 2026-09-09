import type { Session } from "next-auth"

import { AuthError, hasRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

// A project is visible/manageable to: SUPERADMIN/ADMIN, its owner, or its members (view-only
// unless their ProjectMember.role is PROJECT_ADMIN, which grants the same rights as owner).
// A public project is readable by any signed-in user on top of that, but never manageable
// through that route alone — same rule as listProjectsForSession.
export async function loadProjectForAccess(projectId: string, session: Session | null) {
  if (!session?.user) throw new AuthError("Not authenticated", 401)

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      members: true,
      // Group grants live next to the individual ones: they change what the Harbors allow,
      // never what this function decides — the Gateway cannot tell who is in a group.
      groups: { orderBy: { groupName: "asc" } },
      // Never `include` a registry wholesale here: this project object is serialised
      // straight to the client by GET /api/projects/[id], and Registry carries
      // `encryptedSecret`. Only non-secret columns are selected.
      cluster: {
        include: {
          registries: {
            select: { id: true, name: true, baseUrl: true },
            orderBy: { name: "asc" },
          },
        },
      },
      // Per-Harbor state: the project's own placements, plus each robot's.
      placements: { include: { registry: { select: { name: true } } } },
      // Same reasoning: RobotAccount and RobotPlacement both hold an encrypted secret, and
      // a robot secret is only ever revealed once, in the creation response.
      robotAccounts: {
        select: {
          id: true,
          name: true,
          unifiedSecret: true,
          expiresAt: true,
          createdByUserId: true,
          createdAt: true,
          placements: {
            select: {
              registryId: true,
              harborRobotId: true,
              status: true,
              lastError: true,
              registry: { select: { name: true } },
            },
          },
        },
      },
      retentionPolicy: true,
      // At most one can exist (the POST supersedes any earlier ask), and the Quota tab needs
      // it to show a manager that their request is already in the queue.
      quotaRequests: {
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      // A pull request can land in several projects; this one sees the destinations that are
      // its own, each with the request that produced it.
      transferTargets: {
        orderBy: { createdAt: "desc" },
        include: {
          transferRequest: {
            select: {
              sourceImage: true,
              requestedByUserId: true,
              rejectionReason: true,
              source: { select: { name: true } },
            },
          },
        },
      },
    },
  })
  if (!project) throw new AuthError("Not found", 404)

  const isAdmin = hasRole(session, Role.ADMIN)
  const isOwner = project.ownerUserId === session.user.id
  const membership = project.members.find((m) => m.userId === session.user.id)
  const isManager = isAdmin || isOwner || membership?.role === "PROJECT_ADMIN"
  const canView = isManager || Boolean(membership) || project.isPublic

  if (!canView) throw new AuthError("Not authorized", 403)

  return { project, isManager }
}

export function requireManager(isManager: boolean) {
  if (!isManager) throw new AuthError("Not authorized", 403)
}
