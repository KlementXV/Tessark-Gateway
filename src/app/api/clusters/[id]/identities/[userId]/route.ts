import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { revokeClusterIdentity } from "@/lib/clusters/identity-sync"

type Params = { params: Promise<{ id: string; userId: string }> }

// Dropping a mapping revokes every grant it produced on this cluster: the person no longer
// has an account there that anything could name. Their Gateway memberships are untouched —
// map another account and the grants come back under it.
export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id, userId } = await params
  try {
    return NextResponse.json(await revokeClusterIdentity(userId, id))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove the mapping" },
      { status: 502 }
    )
  }
}
