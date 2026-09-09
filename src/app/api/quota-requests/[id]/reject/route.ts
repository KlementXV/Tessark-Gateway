import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { projectRejectInputSchema } from "@/lib/projects/schema"
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
  const parsed = projectRejectInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const quotaRequest = await prisma.quotaRequest.findUnique({
    where: { id },
    include: { project: { select: { name: true } } },
  })
  if (!quotaRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (quotaRequest.status !== "PENDING") {
    return NextResponse.json({ error: "Quota request is not pending approval" }, { status: 400 })
  }

  // The project's quota is left exactly as it was — a rejection is the absence of a change,
  // so there is nothing to fan out here.
  const updated = await prisma.quotaRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      rejectionReason: parsed.data.reason,
      reviewedByUserId: session.user.id,
      reviewedAt: new Date(),
    },
  })

  await notify({
    kind: "QUOTA_REJECTED",
    payload: { project: quotaRequest.project.name, reason: parsed.data.reason },
    audience: { userIds: [quotaRequest.requestedByUserId] },
    href: `/projects/${quotaRequest.projectId}?tab=quota`,
    actorUserId: session.user.id,
  })

  return NextResponse.json(updated)
}
