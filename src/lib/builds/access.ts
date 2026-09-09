import type { Session } from "next-auth"
import { AuthError, authenticateRequest, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

export function projectScope(session: Session) {
  return session.buildProjectScope ? { projectId: { in: session.buildProjectScope } } : {}
}
export async function buildSession(request: Request) {
  const session = await authenticateRequest(request)
  requireRole(session, Role.ADMIN)
  return session
}
export function requireBuildScope(session: Session, projectId: string) {
  if (session.buildProjectScope && !session.buildProjectScope.includes(projectId)) throw new AuthError("Project is outside this token's scope", 403)
}
export async function loadBuild(id: string, session?: Session) {
  const build = await prisma.scheduledBuild.findUnique({ where: { id }, include: { project: { select: { name: true } } } })
  if (!build) throw new AuthError("Build not found", 404)
  if (session) requireBuildScope(session, build.projectId)
  return build
}
