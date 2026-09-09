import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { forgetQueuedGroupOps, syncGroupAcrossCluster } from "@/lib/clusters/project-groups"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"
import { groupAddInputSchema } from "@/lib/projects/schema"

// Granting a directory group a role on the project. Unlike a user grant this needs no identity
// mapping — the group name means the same thing on every Harbor of the cluster — but it also
// makes nobody a member in the Gateway: it is access on the Harbors and nothing else.
type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = groupAddInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // Written first because the fan-out reads its desired state back out of the database, as a
  // queued replay does later. An existing grant has its role updated instead of colliding.
  const group = await prisma.projectGroupMember.upsert({
    where: { projectId_groupName: { projectId: id, groupName: parsed.data.groupName } },
    create: { projectId: id, groupName: parsed.data.groupName, role: parsed.data.role },
    update: { role: parsed.data.role },
  })

  let summary
  try {
    summary = await syncGroupAcrossCluster(id, parsed.data.groupName)
  } catch (err) {
    await prisma.projectGroupMember.delete({ where: { id: group.id } })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to add group" },
      { status: 502 }
    )
  }

  // A grant that reached no Harbor exists nowhere but here, so the row is rolled back rather
  // than left to suggest an access nobody has — same rule as the member route.
  if (summary.succeeded === 0) {
    await forgetQueuedGroupOps(id, parsed.data.groupName)
    await prisma.projectGroupMember.delete({ where: { id: group.id } })

    const detail = summary.failures.map((f) => `${f.registry}: ${f.error}`).join("; ")
    return NextResponse.json(
      {
        error: summary.unknownUserEverywhere
          ? `No Harbor in the cluster holds the group "${parsed.data.groupName}" — it has to exist in their directory before it can be granted access.`
          : `No Harbor in the cluster accepted the group — ${detail}`,
      },
      { status: 502 }
    )
  }

  return NextResponse.json(
    {
      ...group,
      placements: {
        succeeded: summary.succeeded,
        failed: summary.failed,
        failures: summary.failures,
      },
    },
    { status: 201 }
  )
}
