import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { applyMirror, MirrorTransportError } from "@/lib/mirrors/service"

type Params = { params: Promise<{ id: string }> }

// Re-installs the schedule on its transport: the repair for a mirror whose Harbor was down
// when it was created, whose policy someone deleted by hand, or whose push credentials were
// rotated after the CronJob's Secret was written.
export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  try {
    return NextResponse.json(await applyMirror((await params).id))
  } catch (err) {
    if (err instanceof MirrorTransportError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
