import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { ProjectActivationError, activateProject } from "@/lib/projects/activate"
import { prisma } from "@/lib/prisma"
import { notify } from "@/lib/notifications/service"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (project.status !== "PENDING") {
    return NextResponse.json({ error: "Project is not pending approval" }, { status: 400 })
  }

  try {
    // Same path an admin's own direct creation takes — see src/lib/projects/activate.ts.
    const { project: updated, placements } = await activateProject(id, session!.user.id)
    if (project.ownerUserId) {
      await notify({
        kind: "PROJECT_APPROVED",
        payload: { project: updated.name },
        audience: { userIds: [project.ownerUserId] },
        href: `/projects/${updated.id}`,
        actorUserId: session!.user.id,
      })
    }
    return NextResponse.json({ ...updated, placements })
  } catch (err) {
    if (err instanceof ProjectActivationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
