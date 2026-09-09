import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, hasRole, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { ProjectActivationError, activateProject } from "@/lib/projects/activate"
import { listProjectsForSession } from "@/lib/projects/service"
import { projectCreateInputSchema } from "@/lib/projects/schema"
import { notify } from "@/lib/notifications/service"

export async function GET(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const projects = await listProjectsForSession(session!)
  return NextResponse.json(projects)
}

export async function POST(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = projectCreateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id: parsed.data.clusterId },
    include: { _count: { select: { registries: true } } },
  })
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 })
  if (cluster._count.registries === 0) {
    return NextResponse.json(
      { error: "This cluster has no Harbor members yet — add one before requesting a project." },
      { status: 400 }
    )
  }

  let project
  try {
    project = await prisma.project.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description || null,
        clusterId: parsed.data.clusterId,
        isPublic: parsed.data.isPublic,
        ownerUserId: session!.user.id,
      },
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A project with this name already exists on that cluster." }, { status: 409 })
    }
    throw err
  }

  // A request exists to be reviewed by someone with the authority to approve it — which an
  // admin already has. Making them file a request and then approve their own would be a
  // formality with no reviewer, so their project is created on the cluster right away.
  if (!hasRole(session, Role.ADMIN)) {
    await notify({
      kind: "PROJECT_REQUESTED",
      payload: { project: project.name, cluster: cluster.name },
      audience: { admins: true },
      href: "/requests",
      actorUserId: session!.user.id,
    })
    return NextResponse.json(project, { status: 201 })
  }

  try {
    const { project: activated, placements } = await activateProject(project.id, session!.user.id)
    return NextResponse.json({ ...activated, placements }, { status: 201 })
  } catch (err) {
    if (err instanceof ProjectActivationError) {
      // The row survives as PENDING rather than being rolled back: the project is defined,
      // only the Harbor side failed. It shows up in Requests, where approving it retries the
      // exact same fan-out once the cluster is reachable again.
      return NextResponse.json(
        { error: `${err.message} — saved as a pending request you can approve to retry.` },
        { status: err.status },
      )
    }
    throw err
  }
}
