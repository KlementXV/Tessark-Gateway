import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { changeUserPassword } from "@/lib/users/profile"
import { passwordChangeInputSchema } from "@/lib/users/schema"

export async function POST(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = passwordChangeInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    // Re-verifies the current password, and refuses accounts whose credentials live in an
    // external directory.
    await changeUserPassword(session.user.id, parsed.data.currentPassword, parsed.data.newPassword)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
}
