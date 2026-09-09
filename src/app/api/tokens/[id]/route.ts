import { NextResponse } from "next/server"

import { revokeApiToken } from "@/lib/api-tokens/service"
import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"

type Params = { params: Promise<{ id: string }> }

export async function DELETE(request: Request, { params }: Params) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  try {
    await revokeApiToken(id, session.user)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
}
