import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { decryptSecret } from "@/lib/crypto"
import { checkSource } from "@/lib/sources/check"

// Advisory probe for source details typed into the add/edit form. It is deliberately not
// wired into POST/PATCH /api/sources as a guard: the pull is executed by skopeo running in
// the Harbor clusters, not here, and the gateway may well sit in a network that cannot reach
// an upstream the clusters reach fine. A failed check is information for the admin, never a
// reason to refuse the source.
//
// `id` lets the edit form re-test without re-entering the stored credential.
const checkInputSchema = z.object({
  id: z.string().optional(),
  host: z.string().min(1).max(253),
  authType: z.enum(["none", "basic", "token"]).default("none"),
  username: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  probeRepo: z.string().max(200).optional().nullable(),
})

export async function POST(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = checkInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { id, secret, ...input } = parsed.data

  let storedSecret: string | null = null
  if (id && !secret) {
    const stored = await prisma.upstreamSource.findUnique({ where: { id } })
    storedSecret = stored?.encryptedSecret ? decryptSecret(stored.encryptedSecret) : null
  }

  return NextResponse.json(
    await checkSource({
      host: input.host,
      authType: input.authType,
      username: input.username ?? null,
      secret: secret || storedSecret,
      probeRepo: input.probeRepo ?? null,
    }),
  )
}
