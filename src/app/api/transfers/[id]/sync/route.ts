import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { deleteJob, deleteSecret, getJobPhase } from "@/lib/k8s/client"
import { prisma } from "@/lib/prisma"
import { canViewTransferRequest } from "@/lib/transfers/access"
import { refreshTransferStatus } from "@/lib/transfers/status"

type Params = { params: Promise<{ id: string }> }

// Polled on-demand (e.g. when a project's Transfers tab loads) rather than watched — reads each
// running Job's terminal state from Kubernetes and reflects it back onto its TransferTarget, then
// rolls the request up.
//
// This is the piece that has to move server-side once mirrors run on a schedule: nothing here
// happens unless somebody has the page open.
export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  let session: Session | null

  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const transferRequest = await prisma.transferRequest.findUnique({
    where: { id },
    include: {
      targets: {
        include: {
          project: {
            select: { isPublic: true, ownerUserId: true, members: { select: { userId: true } } },
          },
        },
      },
    },
  })
  if (!transferRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!canViewTransferRequest(transferRequest, session)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  const running = transferRequest.targets.filter(
    (target) => target.status === "RUNNING" && target.k8sJobName,
  )

  await Promise.all(
    running.map(async (target) => {
      const jobName = target.k8sJobName!
      const phase = await getJobPhase(jobName).catch(() => "running" as const)
      if (phase === "running") return

      await prisma.transferTarget.update({
        where: { id: target.id },
        data: {
          status: phase === "succeeded" ? "SUCCEEDED" : "FAILED",
          errorMessage: phase === "succeeded" ? null : "The mirror job failed — check its logs.",
          syncedAt: new Date(),
        },
      })

      await Promise.all([
        deleteSecret(`${jobName}-creds`).catch(() => {}),
        deleteSecret(`${jobName}-creds-ca`).catch(() => {}),
        deleteJob(jobName).catch(() => {}),
      ])
    }),
  )

  const refreshed = await refreshTransferStatus(id)
  return NextResponse.json(refreshed ?? transferRequest)
}
