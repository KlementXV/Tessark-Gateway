import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { syncClusterReplication } from "@/lib/clusters/replication"

type Params = { params: Promise<{ id: string }> }

// Re-weaves the mesh alone, without the placement replay and project adoption that
// POST /api/clusters/[id]/reconcile also performs: an admin looking at a broken link wants
// exactly the policies rebuilt, and the wider reconcile talks to every Harbor twice more.
//
// Forced, unlike the syncs triggered as a side effect elsewhere: this route exists to *check
// and repair*, so it must rewrite every endpoint and re-probe every edge rather than trust the
// fingerprint that says nothing changed — the fingerprint is exactly what a hand-edited Harbor
// would have made stale.
export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params

  try {
    return NextResponse.json(await syncClusterReplication(id, { force: true }))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cluster not found" },
      { status: 404 }
    )
  }
}
