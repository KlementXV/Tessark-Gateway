import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { ProjectDeleteError, deleteProjectEverywhere } from "@/lib/projects/delete"
import { notify } from "@/lib/notifications/service"

type Params = { params: Promise<{ id: string }> }

// Lives outside /projects/[id] for the same reason transfer and quota approvals do: the
// reviewer works from the queue and holds the request's id, not the project's — and by the time
// this returns, the project's id names nothing.
export async function POST(request: Request, { params }: Params) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const deleteRequest = await prisma.projectDeleteRequest.findUnique({
    where: { id },
  })
  if (!deleteRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (deleteRequest.status !== "PENDING") {
    return NextResponse.json({ error: "Deletion request is not pending approval" }, { status: 400 })
  }

  // The project goes first, and its refusals are the reviewer's refusals: a project still
  // holding repositories is not deletable by anyone, so the request stays PENDING rather than
  // being marked approved over a deletion that never happened. The row survives the project
  // (SetNull, see the model) precisely so it can then be marked with what was decided.
  const projectId = deleteRequest.projectId
  const projectName = deleteRequest.projectName
  if (!projectId) {
    return NextResponse.json(
      { error: `${projectName} no longer exists — nothing left to delete.` },
      { status: 409 },
    )
  }
  let summary
  try {
    summary = await deleteProjectEverywhere(projectId)
  } catch (err) {
    if (err instanceof ProjectDeleteError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const updated = await prisma.projectDeleteRequest.update({
    where: { id },
    data: { status: "APPROVED", reviewedByUserId: session!.user.id, reviewedAt: new Date() },
  })

  await notify({
    kind: "PROJECT_DELETE_APPROVED",
    payload: { project: projectName },
    audience: { userIds: [deleteRequest.requestedByUserId] },
    href: "/projects",
    actorUserId: session!.user.id,
  })

  return NextResponse.json({ ok: true, project: projectName, ...updated, ...summary })
}
