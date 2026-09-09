import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { notify } from "@/lib/notifications/service"
import { projectRejectInputSchema } from "@/lib/projects/schema"

import { withTransferLock, TransferLaunchError } from "@/lib/transfers/lock"

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

  try {
    return await withTransferLock(id, async () => {
      const transferRequest = await prisma.transferRequest.findUnique({ where: { id } })
      if (!transferRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })
      if (transferRequest.status !== "PENDING") {
        return NextResponse.json({ error: "Transfer request is not pending approval" }, { status: 400 })
      }

      // Targets are settled alongside the request: leaving them PENDING would show a rejected
      // request with destinations still apparently waiting to run.
      const [updated] = await prisma.$transaction([
        prisma.transferRequest.update({
          where: { id },
          data: {
            status: "REJECTED",
            rejectionReason: parsed.data.reason,
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
          },
        }),
        prisma.transferTarget.updateMany({
          where: { transferRequestId: id, status: "PENDING" },
          data: { status: "REJECTED", errorMessage: parsed.data.reason },
        }),
      ])

      await notify({
        kind: "TRANSFER_REJECTED",
        payload: { image: transferRequest.sourceImage, reason: parsed.data.reason },
        audience: { userIds: [transferRequest.requestedByUserId] },
        href: "/projects/requests",
        actorUserId: session.user.id,
      })

      return NextResponse.json(updated)
    })
  } catch (error) {
    if (error instanceof TransferLaunchError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
