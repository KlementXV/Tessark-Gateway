import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { TransferLaunchError, launchTransferRequest } from "@/lib/transfers/launch"
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
  const transferRequest = await prisma.transferRequest.findUnique({
    where: { id },
    select: { status: true, sourceImage: true, requestedByUserId: true },
  })
  if (!transferRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (transferRequest.status !== "PENDING") {
    return NextResponse.json({ error: "Transfer request is not pending approval" }, { status: 400 })
  }

  try {
    // Same path an admin's own direct pull takes — see src/lib/transfers/launch.ts.
    const updated = await launchTransferRequest(id, session!.user.id)
    await notify({
      kind: "TRANSFER_APPROVED",
      payload: { image: transferRequest.sourceImage },
      audience: { userIds: [transferRequest.requestedByUserId] },
      href: "/projects/requests",
      actorUserId: session!.user.id,
    })
    return NextResponse.json(updated)
  } catch (err) {
    if (err instanceof TransferLaunchError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
