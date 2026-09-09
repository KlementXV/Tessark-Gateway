import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { MirrorTransportError, runMirrorNow } from "@/lib/mirrors/service"

type Params = { params: Promise<{ id: string }> }

// Runs the copy now instead of at the next tick — for the operator who has just fixed the
// upstream and does not want to wait until 3am to find out whether it worked.
export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  try {
    await runMirrorNow((await params).id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof MirrorTransportError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
