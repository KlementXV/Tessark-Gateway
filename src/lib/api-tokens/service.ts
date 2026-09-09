import { generateApiToken } from "@/lib/api-tokens/generate"
import type { ApiTokenCreateInput } from "@/lib/api-tokens/schema"
import { AuthError } from "@/lib/auth/guard"
import { getConfig } from "@/lib/config"
import type { ApiToken } from "@/generated/prisma/client"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

const MS_PER_DAY = 24 * 60 * 60 * 1000

function assertWithinMaxTtl(expiresAt: Date): void {
  const maxDays = getConfig().apiTokenMaxTtlDays
  if (expiresAt.getTime() - Date.now() > maxDays * MS_PER_DAY) {
    throw new AuthError(`Expiry cannot be more than ${maxDays} days out.`, 400)
  }
}

export async function createApiToken(
  userId: string,
  input: ApiTokenCreateInput,
): Promise<{ record: ApiToken; token: string }> {
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
  if (expiresAt) assertWithinMaxTtl(expiresAt)

  // tokenPrefix collisions are astronomically unlikely (48 random bits) but not impossible —
  // retry with a freshly generated token rather than surface a 500 for a legitimate request.
  for (let attempt = 0; attempt < 3; attempt++) {
    const generated = generateApiToken()
    try {
      const record = await prisma.apiToken.create({
        data: {
          name: input.name,
          tokenPrefix: generated.tokenPrefix,
          tokenHash: generated.tokenHash,
          userId,
          expiresAt,
        },
      })
      return { record, token: generated.token }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Unique constraint")) continue
      throw err
    }
  }
  throw new Error("Failed to generate a unique API token after several attempts")
}

export function listTokensForUser(userId: string): Promise<ApiToken[]> {
  return prisma.apiToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" } })
}

/** Self-revocation, or ADMIN+ revoking anyone's — idempotent if already revoked. */
export async function revokeApiToken(id: string, actor: { id: string; role: Role }): Promise<void> {
  const token = await prisma.apiToken.findUnique({ where: { id } })
  if (!token) throw new AuthError("Token not found", 404)

  const isOwner = token.userId === actor.id
  const isAdmin = actor.role === Role.ADMIN || actor.role === Role.SUPERADMIN
  if (!isOwner && !isAdmin) throw new AuthError("Not authorized", 403)

  if (token.revokedAt) return
  await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } })
}
