import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { encryptSecret } from "@/lib/crypto"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { toPublicSource } from "@/lib/sources/public"
import { sourceUpdateInputSchema } from "@/lib/sources/schema"
import { mirrorBlockMessage, mirrorsBlockingDelete } from "@/lib/mirrors/references"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const parsed = sourceUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { secret, allowedRepos, authType, username, ...data } = parsed.data

  // Dropping to "none" is the one edit that must actively clear what is stored: leaving a
  // password behind on a source that no longer authenticates would hand it back the next time
  // somebody flips the mode on again, long after whoever set it has forgotten.
  const credentials =
    authType === "none"
      ? { authType, username: null, encryptedSecret: null }
      : {
          ...(authType ? { authType } : {}),
          ...(username !== undefined ? { username: username || null } : {}),
          // An omitted secret means "keep the stored one" — a PATCH that only renames the
          // source must not wipe its credentials.
          ...(secret ? { encryptedSecret: encryptSecret(secret) } : {}),
        }

  try {
    const source = await prisma.upstreamSource.update({
      where: { id },
      data: {
        ...data,
        ...credentials,
        ...(allowedRepos ? { allowedRepos: JSON.stringify(allowedRepos) } : {}),
      },
    })
    return NextResponse.json(toPublicSource(source))
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json(
        { error: "A source with this name or host already exists." },
        { status: 409 },
      )
    }
    if (err instanceof Error && err.message.includes("Record to update not found")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    throw err
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params

  // A mirror reading from this source owns a schedule that only DELETE /api/mirrors/[id]
  // uninstalls. Refused by name rather than by foreign key.
  const blocking = await mirrorsBlockingDelete({ sourceId: id })
  if (blocking.length > 0) {
    return NextResponse.json({ error: mirrorBlockMessage("source", blocking) }, { status: 409 })
  }

  // Past pull requests survive: their `sourceId` is nulled (onDelete: SetNull) while
  // `sourceImage` keeps recording what was actually mirrored. Disabling is still the better
  // move for a source being retired — see UpstreamSource.enabled.
  await prisma.upstreamSource.delete({ where: { id } }).catch(() => null)
  return NextResponse.json({ ok: true })
}
