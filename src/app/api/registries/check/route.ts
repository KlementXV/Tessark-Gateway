import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { checkRegistryHealth } from "@/lib/registries/check"
import { loadConnection } from "@/lib/registries/load"
import type { RegistryAuthType, RegistryConnection } from "@/lib/registries/types"

// Dry-run probe for connection details typed into the add/edit form, before anything is
// stored. `id` lets the edit form re-test an existing registry without re-entering its
// password: a blank `secret` falls back to the stored one.
const checkInputSchema = z.object({
  id: z.string().optional(),
  baseUrl: z.string().url(),
  authType: z.enum(["none", "basic", "token"]).default("none"),
  username: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  insecureTLS: z.boolean().default(false),
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
  const stored = id ? await loadConnection(id) : null

  const conn: RegistryConnection = {
    id: id ?? "",
    name: stored?.name ?? "",
    baseUrl: input.baseUrl,
    authType: input.authType as RegistryAuthType,
    username: input.username ?? null,
    secret: secret || (stored?.secret ?? null),
    insecureTLS: input.insecureTLS,
  }

  return NextResponse.json(await checkRegistryHealth(conn))
}
