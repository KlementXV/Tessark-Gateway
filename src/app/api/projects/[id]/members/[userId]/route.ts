import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { resolveHarborUsername } from "@/lib/clusters/identity"
import { removeMemberAcrossCluster } from "@/lib/clusters/project-members"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"

type Params = { params: Promise<{ id: string; userId: string }> }

export async function DELETE(request: Request, { params }: Params) {
  const { id, userId } = await params
  let project
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
    project = access.project
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  // The owner is a manager by virtue of Project.ownerUserId, not of this row: removing it
  // would strip their Harbor access while leaving them in charge here, and it would let a
  // PROJECT_ADMIN they appointed lock them out of their own project. The UI already hides the
  // action; this is the rule itself.
  if (project.ownerUserId === userId) {
    return NextResponse.json(
      { error: "The project owner cannot be removed from their own project." },
      { status: 409 }
    )
  }

  // What Harbor knows this person by — which on a cluster with its own directory is the
  // mapped account, not User.username. It has to be resolved before the row goes away, since
  // the queued removals carry it for members that are down right now.
  const harborUsername = await resolveHarborUsername(userId, project.clusterId)

  // Revoked on the Harbors first: dropping the row on a fan-out failure would leave the grant
  // in place on every member with nothing left in the Gateway pointing at it. An unresolvable
  // name means no grant was ever pushed under one, so there is nothing to revoke.
  const summary = harborUsername
    ? await removeMemberAcrossCluster(id, userId, harborUsername)
    : null

  await prisma.projectMember.deleteMany({ where: { projectId: id, userId } })

  return NextResponse.json({
    ok: true,
    placements: summary
      ? { succeeded: summary.succeeded, failed: summary.failed, failures: summary.failures }
      : null,
  })
}
