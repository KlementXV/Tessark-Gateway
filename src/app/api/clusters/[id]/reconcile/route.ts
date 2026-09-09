import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { adoptHarborProjects } from "@/lib/clusters/adopt"
import { reconcileCluster } from "@/lib/clusters/reconcile"
import { syncClusterReplication } from "@/lib/clusters/replication"

type Params = { params: Promise<{ id: string }> }

// Forces the replay that normally happens on its own once a member's health probe goes green
// again — useful when an admin has just fixed a Harbor and doesn't want to wait for the next
// health read. Also repairs the replication mesh, since a member that was down when the
// cluster changed shape never got its policies.
export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params

  const results = await reconcileCluster(id)

  let replication
  try {
    // Forced for the same reason as POST /replication: this is the "I have just fixed a
    // Harbor" button, and what was fixed is invisible to the fingerprint.
    replication = await syncClusterReplication(id, { force: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cluster not found" },
      { status: 404 }
    )
  }

  // Runs last: the replay above may have just created placements, and adoption should only
  // claim what the Gateway still doesn't know about afterwards.
  const adoption = await adoptHarborProjects(id)

  return NextResponse.json({
    members: results,
    adopted: adoption.adopted,
    replayed: results.reduce((sum, r) => sum + r.replayed, 0),
    remaining: results.reduce((sum, r) => sum + r.remaining, 0),
    unreachable: results.filter((r) => r.skipped).length,
    replication,
  })
}
