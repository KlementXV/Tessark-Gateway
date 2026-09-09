import { NextResponse } from "next/server"

import type { Session } from "next-auth"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { notify } from "@/lib/notifications/service"
import { projectRejectInputSchema } from "@/lib/projects/schema"

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
  const body = await request.json().catch(() => null)
  const parsed = projectRejectInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (project.status !== "PENDING") {
    return NextResponse.json({ error: "Project is not pending approval" }, { status: 400 })
  }

  const updated = await prisma.project.update({
    where: { id },
    data: { status: "REJECTED", rejectionReason: parsed.data.reason },
  })

  if (project.ownerUserId) {
    await notify({
      kind: "PROJECT_REJECTED",
      payload: { project: updated.name, reason: parsed.data.reason },
      audience: { userIds: [project.ownerUserId] },
      href: "/projects/requests",
      actorUserId: session.user.id,
    })
  }

  return NextResponse.json(updated)
}
