import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { removeGroupAcrossCluster } from "@/lib/clusters/project-groups"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"

type Params = { params: Promise<{ id: string; groupName: string }> }

export async function DELETE(request: Request, { params }: Params) {
  const { id, groupName: raw } = await params
  const groupName = decodeURIComponent(raw)
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  // Revoked on the Harbors first: dropping the row on a fan-out failure would leave the grant
  // in place on every member with nothing left in the Gateway pointing at it.
  const summary = await removeGroupAcrossCluster(id, groupName)
  await prisma.projectGroupMember.deleteMany({ where: { projectId: id, groupName } })

  return NextResponse.json({
    ok: true,
    placements: {
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: summary.failures,
    },
  })
}
