import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { listGatewayJobs } from "@/lib/jobs/view"

// ADMIN, matching /api/mirrors and the admin transfer queue: this lists every image movement
// happening in the estate, across all projects, which is not a project member's view.
export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  return NextResponse.json(await listGatewayJobs())
}
