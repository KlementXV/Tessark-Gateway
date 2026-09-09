// Resolves a request's `Authorization: Bearer <token>` header into a NextAuth-shaped Session,
// so the rest of the app (requireRole, route handlers) never has to know whether a caller
// authenticated with a session cookie or an ApiToken — see authenticateRequest in guard.ts,
// the only place that decides which of the two applies.
import type { Session } from "next-auth"

import { splitApiToken } from "@/lib/api-tokens/generate"
import { checkRateLimit, clientIp } from "@/lib/api-tokens/rate-limit"
import { verifyPassword } from "@/lib/crypto"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"

// Session.expires is unused by requireRole/hasRole (they only read session.user), but the
// type requires a value — pick something implausibly far out for a token with no expiresAt
// rather than lie about an expiry that doesn't exist.
const FAR_FUTURE_EXPIRY = new Date("9999-01-01T00:00:00.000Z").toISOString()

// Rate-limit exceeded is reported through the return value rather than a thrown AuthError:
// Next.js's per-route bundling can give this module and guard.ts's `instanceof AuthError`
// check two structurally-identical but distinct copies of that class across the chunk
// boundary, silently turning a 429 into a 500. authenticateRequest (guard.ts) is the one
// place allowed to throw AuthError, since that's also where authErrorResponse's `instanceof`
// check lives — same module, guaranteed same class reference.
export type ResolveApiTokenResult =
  | { session: Session; tokenId: string; rateLimited: false }
  | { session: null; rateLimited: false }
  | { session: null; rateLimited: true; retryAfterSeconds: number }

const NOT_RATE_LIMITED = { rateLimited: false as const }

export async function resolveApiToken(request: Request): Promise<ResolveApiTokenResult> {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return { session: null, ...NOT_RATE_LIMITED }

  const parts = splitApiToken(header.slice("Bearer ".length).trim())
  if (!parts) return { session: null, ...NOT_RATE_LIMITED }

  const record = await prisma.apiToken.findUnique({ where: { tokenPrefix: parts.tokenPrefix } })

  // Keyed by the token's own id once a record is found — even before its secret is verified,
  // so a leaked prefix can't be brute-forced past the limit — falling back to the client IP
  // for a prefix that matches nothing at all.
  const rateLimit = checkRateLimit(record ? `token:${record.id}` : `ip:${clientIp(request)}`)
  if (!rateLimit.allowed) {
    return { session: null, rateLimited: true, retryAfterSeconds: rateLimit.retryAfterSeconds }
  }

  if (!record) return { session: null, ...NOT_RATE_LIMITED }
  if (record.revokedAt) return { session: null, ...NOT_RATE_LIMITED }
  if (record.expiresAt && record.expiresAt.getTime() < Date.now()) return { session: null, ...NOT_RATE_LIMITED }
  if (!verifyPassword(parts.secret, record.tokenHash)) return { session: null, ...NOT_RATE_LIMITED }

  // Always re-fetched live, never cached on the token row: a disabled/deleted user
  // invalidates every one of their tokens immediately, with no separate revocation step.
  const user = await prisma.user.findUnique({ where: { id: record.userId } })
  if (!user || user.disabled) return { session: null, ...NOT_RATE_LIMITED }

  // Best-effort — a stats field must never block or fail the request it's timestamping.
  prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => logger.warn("Failed to update ApiToken.lastUsedAt", { tokenId: record.id, err: String(err) }))

  return {
    session: {
      user: { id: user.id, role: user.role, name: user.name ?? user.username, email: user.email },
      ...(record.scopeProjectIds ? { buildProjectScope: parseProjectScope(record.scopeProjectIds) } : {}),
      expires: record.expiresAt?.toISOString() ?? FAR_FUTURE_EXPIRY,
    },
    tokenId: record.id,
    ...NOT_RATE_LIMITED,
  }
}

// Fail closed for malformed legacy token scopes.
function parseProjectScope(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((id) => typeof id === "string") ? parsed : [] } catch { return [] }
}
