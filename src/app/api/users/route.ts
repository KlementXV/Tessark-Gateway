import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { hashPassword } from "@/lib/crypto"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { toPublicUser } from "@/lib/users/public"
import { userCreateInputSchema } from "@/lib/users/schema"

export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } })
  return NextResponse.json(users.map(toPublicUser))
}

export async function POST(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = userCreateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { password, ...data } = parsed.data

  try {
    const user = await prisma.user.create({
      data: { ...data, passwordHash: hashPassword(password) },
    })
    return NextResponse.json(toPublicUser(user), { status: 201 })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A user with this username or email already exists." }, { status: 409 })
    }
    throw err
  }
}
