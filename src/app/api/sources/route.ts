import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, hasRole, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { encryptSecret } from "@/lib/crypto"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { toPublicSource } from "@/lib/sources/public"
import { sourceInputSchema } from "@/lib/sources/schema"
import { listPickableSources, listSources } from "@/lib/sources/service"

// Two audiences, one route: an admin manages sources, everyone else only needs the list to
// fill a pull request form. The narrower shape carries no credential state at all.
export async function GET(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (!hasRole(session, Role.ADMIN)) {
    return NextResponse.json(await listPickableSources())
  }
  return NextResponse.json(await listSources())
}

export async function POST(request: Request) {
  try {
    const session = await authenticateRequest(request)
    requireUser(session)
    if (!hasRole(session, Role.ADMIN)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 })
    }
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = sourceInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { secret, allowedRepos, authType, username, ...data } = parsed.data

  try {
    const source = await prisma.upstreamSource.create({
      data: {
        ...data,
        authType,
        // A credential only means something alongside an auth mode that uses it — storing a
        // username on a "none" source would resurface the next time somebody edits it.
        username: authType !== "none" ? username || null : null,
        encryptedSecret: authType !== "none" && secret ? encryptSecret(secret) : null,
        allowedRepos: JSON.stringify(allowedRepos),
      },
    })
    return NextResponse.json(toPublicSource(source), { status: 201 })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json(
        { error: "A source with this name or host already exists." },
        { status: 409 },
      )
    }
    throw err
  }
}
