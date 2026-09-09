import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { QuotaUpdateError, applyProjectQuota, formatQuotaMib } from "@/lib/projects/quota"
import { notify } from "@/lib/notifications/service"

type Params = { params: Promise<{ id: string }> }

// Lives outside /projects/[id] for the same reason pull approvals do: the reviewer works from
// the queue and has the request's id, not the project's.
export async function POST(request: Request, { params }: Params) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const quotaRequest = await prisma.quotaRequest.findUnique({
    where: { id },
    include: { project: { select: { name: true } } },
  })
  if (!quotaRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (quotaRequest.status !== "PENDING") {
    return NextResponse.json({ error: "Quota request is not pending approval" }, { status: 400 })
  }

  // The quota moves first: a request marked APPROVED while the fan-out reached no Harbor
  // would claim a limit that exists nowhere, and the reviewer would have nothing left in the
  // queue to retry it from.
  let result
  try {
    result = await applyProjectQuota(quotaRequest.projectId, quotaRequest.requestedQuotaMib)
  } catch (err) {
    if (err instanceof QuotaUpdateError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const updated = await prisma.quotaRequest.update({
    where: { id },
    data: { status: "APPROVED", reviewedByUserId: session.user.id, reviewedAt: new Date() },
  })

  await notify({
    kind: "QUOTA_APPROVED",
    payload: {
      project: quotaRequest.project.name,
      quota: formatQuotaMib(quotaRequest.requestedQuotaMib),
    },
    audience: { userIds: [quotaRequest.requestedByUserId] },
    href: `/projects/${quotaRequest.projectId}?tab=quota`,
    actorUserId: session.user.id,
  })

  return NextResponse.json({ ...updated, ...result })
}
