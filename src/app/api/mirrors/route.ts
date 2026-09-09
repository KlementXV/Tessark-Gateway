import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { mirrorCreateInputSchema } from "@/lib/mirrors/schema"
import { createMirror, listMirrors } from "@/lib/mirrors/service"
import { MirrorValidationError } from "@/lib/mirrors/validate"

// ADMIN throughout: a mirror puts bytes in a project every day without anyone looking, which
// is the standing version of the approval an admin gives one transfer at a time. The
// direction still has to be opened by a TransferRule first (SUPERADMIN), so this is a
// permission to *repeat* what the policy already allows, not to widen it.
export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  return NextResponse.json(await listMirrors())
}

export async function POST(request: Request) {
  let session
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = mirrorCreateInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    // 201 even when the transport refused to install it: the definition is saved, and the row
    // carries `applied: false` with the reason so the operator can fix the Harbor and retry
    // instead of retyping the mirror.
    return NextResponse.json(await createMirror(parsed.data, session.user.id), { status: 201 })
  } catch (err) {
    if (err instanceof MirrorValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A mirror with this name already exists." }, { status: 409 })
    }
    throw err
  }
}
