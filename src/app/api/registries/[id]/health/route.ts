import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { checkRegistryHealth } from "@/lib/registries/check"
import { loadConnection } from "@/lib/registries/load"
import { recordHarborObservationInBackground } from "@/lib/registries/version-cache"

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const conn = await loadConnection(id)
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const health = await checkRegistryHealth(conn)
  // Unlike POST /api/registries/check, this route is addressed *by id* and probes what the row
  // says, so the reading it obtains genuinely belongs to that registry.
  recordHarborObservationInBackground({ id, baseUrl: conn.baseUrl }, health)
  return NextResponse.json(health)
}
