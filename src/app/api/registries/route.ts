import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { encryptSecret } from "@/lib/crypto"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { toPublicRegistry } from "@/lib/registries/public"
import { registryInputSchema } from "@/lib/registries/schema"
import { connectionFromInput, listRegistriesWithHealth, rejectionReason } from "@/lib/registries/service"

export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const withHealth = await listRegistriesWithHealth()
  return NextResponse.json(withHealth)
}

export async function POST(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = registryInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { secret, ...data } = parsed.data

  // Only live, authenticated Harbors get stored — see rejectionReason().
  const reason = await rejectionReason(connectionFromInput(data, secret ?? null))
  if (reason) return NextResponse.json({ error: reason }, { status: 422 })

  try {
    const registry = await prisma.registry.create({
      data: {
        ...data,
        encryptedSecret: secret ? encryptSecret(secret) : null,
      },
    })
    return NextResponse.json(toPublicRegistry(registry), { status: 201 })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A registry with this URL already exists." }, { status: 409 })
    }
    throw err
  }
}
