// Role ordering, split out of guard.ts so the OIDC role mapper can compare roles without
// importing guard.ts — guard.ts pulls in NextAuth and the Prisma-backed token resolver,
// neither of which the mapper needs, and one of which would make it unusable from the
// auth config itself.
import { Role } from "@/generated/prisma/client"

export const ROLE_RANK: Record<Role, number> = {
  [Role.USER]: 0,
  [Role.ADMIN]: 1,
  [Role.SUPERADMIN]: 2,
}

/** The most privileged of the given roles, or `fallback` when the list is empty. */
export function highestRole(roles: Role[], fallback: Role): Role {
  if (roles.length === 0) return fallback
  return roles.reduce((best, role) => (ROLE_RANK[role] > ROLE_RANK[best] ? role : best))
}
