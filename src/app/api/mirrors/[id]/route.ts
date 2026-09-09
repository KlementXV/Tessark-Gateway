import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { mirrorUpdateInputSchema } from "@/lib/mirrors/schema"
import { deleteMirror, MirrorTransportError, updateMirror } from "@/lib/mirrors/service"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = mirrorUpdateInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    return NextResponse.json(await updateMirror((await params).id, parsed.data))
  } catch (err) {
    if (err instanceof MirrorTransportError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
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

  try {
    await deleteMirror((await params).id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof MirrorTransportError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
