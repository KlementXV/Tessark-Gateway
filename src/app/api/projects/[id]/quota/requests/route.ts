import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"
import { quotaRequestInputSchema } from "@/lib/projects/schema"
import { formatQuotaMib } from "@/lib/projects/quota"
import { notify } from "@/lib/notifications/service"

type Params = { params: Promise<{ id: string }> }

// A project manager (owner, PROJECT_ADMIN, or an admin acting on the project) asking for a
// different storage limit. Setting the limit stays an admin's call — see PUT ../quota — so
// this writes an intention an admin reviews from the Requests queue, nothing more.
export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  let session: Session | null
  let project
  try {
    session = await authenticateRequest(request)
    const access = await loadProjectForAccess(id, session)
    requireManager(access.isManager)
    project = access.project
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project must be active before requesting a quota" }, { status: 400 })
  }

  const parsed = quotaRequestInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  if (parsed.data.storageQuotaMib === project.storageQuotaMib) {
    return NextResponse.json({ error: "That is already the project's quota" }, { status: 400 })
  }

  // One pending ask per project: a manager who changes their mind supersedes their previous
  // number instead of stacking a second one, so the queue never shows an admin two
  // contradictory limits for the same project. Superseding is a withdrawal, not a rejection —
  // it carries no reviewer.
  const [, quotaRequest] = await prisma.$transaction([
    prisma.quotaRequest.deleteMany({ where: { projectId: id, status: "PENDING" } }),
    prisma.quotaRequest.create({
      data: {
        projectId: id,
        requestedQuotaMib: parsed.data.storageQuotaMib,
        currentQuotaMib: project.storageQuotaMib,
        reason: parsed.data.reason,
        requestedByUserId: session!.user.id,
      },
    }),
  ])

  await notify({
    kind: "QUOTA_REQUESTED",
    payload: {
      project: project.name,
      change: `${formatQuotaMib(project.storageQuotaMib)} → ${formatQuotaMib(parsed.data.storageQuotaMib)}`,
    },
    audience: { admins: true },
    href: "/requests",
    actorUserId: session!.user.id,
  })

  return NextResponse.json(quotaRequest, { status: 201 })
}
