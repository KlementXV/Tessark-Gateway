import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { loadProjectForAccess } from "@/lib/projects/access"
import { projectDeleteRequestInputSchema } from "@/lib/projects/schema"
import { prisma } from "@/lib/prisma"
import { notify } from "@/lib/notifications/service"

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/projects/[id]/delete-requests — ask for this project to be taken down.
 *
 * Open to anyone who can see the project, which is wider than the direct delete on purpose: a
 * manager already has that button, and this exists for everybody else — the member who knows
 * the project is finished but cannot act on it. Whether it goes is still an admin's decision,
 * and the same refusals apply to them (see src/lib/projects/delete.ts).
 *
 * One open request at a time. A second ask while the first is pending is the same ask, and two
 * rows in the queue for one project would let a reviewer approve one and reject the other.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  let project
  let session
  try {
    session = await authenticateRequest(request)
    ;({ project } = await loadProjectForAccess(id, session))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = projectDeleteRequestInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const existing = await prisma.projectDeleteRequest.findFirst({
    where: { projectId: id, status: "PENDING" },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      { error: "A deletion request for this project is already waiting for review." },
      { status: 409 },
    )
  }

  const created = await prisma.projectDeleteRequest.create({
    data: {
      projectId: id,
      // Frozen at the ask, so the queue and the history still name the project once it is gone.
      projectName: project.name,
      reason: parsed.data.reason,
      requestedByUserId: session!.user.id,
    },
  })

  await notify({
    kind: "PROJECT_DELETE_REQUESTED",
    payload: { project: project.name, reason: parsed.data.reason },
    audience: { admins: true },
    href: "/requests",
    actorUserId: session!.user.id,
  })

  return NextResponse.json(created, { status: 201 })
}
