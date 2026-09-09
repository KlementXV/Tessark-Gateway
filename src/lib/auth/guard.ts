import { NextResponse } from "next/server"

import { auth } from "@/auth"
import { Role } from "@/generated/prisma/client"
import { resolveApiToken } from "@/lib/auth/api-token"
import { AuthError } from "@/lib/auth/errors"
import { ROLE_RANK } from "@/lib/auth/role-rank"
import { getConfig } from "@/lib/config"
import type { Session } from "next-auth"

export { AuthError } from "@/lib/auth/errors"

// Session cookie first (the frontend never sends a Bearer header), ApiToken second. A Bearer
// token is only ever consulted when API_EXTERNAL_ENABLED is true — an operator who never
// turns that flag on gets the exact same auth surface as before this existed, even if
// ApiToken rows already exist in the database.
export async function authenticateRequest(request: Request): Promise<Session | null> {
  const session = await auth()
  if (session) return session

  if (!getConfig().apiExternalEnabled) return null

  const result = await resolveApiToken(request)
  if (result.rateLimited) {
    throw new AuthError("Too many requests", 429, { "Retry-After": String(result.retryAfterSeconds) })
  }
  return result.session
}

export function requireUser(session: Session | null): asserts session is Session {
  if (!session?.user) throw new AuthError("Not authenticated", 401)
}

export function requireRole(session: Session | null, minRole: Role): asserts session is Session {
  requireUser(session)
  if (ROLE_RANK[session.user.role] < ROLE_RANK[minRole]) {
    throw new AuthError("Not authorized", 403)
  }
}

export function hasRole(session: Session | null, minRole: Role): boolean {
  if (!session?.user) return false
  return ROLE_RANK[session.user.role] >= ROLE_RANK[minRole]
}

export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status, headers: err.headers })
  }
  return null
}
