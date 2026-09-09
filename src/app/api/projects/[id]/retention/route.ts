import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { syncRetentionAcrossCluster } from "@/lib/clusters/retention"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"
import { retentionUpdateInputSchema } from "@/lib/projects/schema"

type Params = { params: Promise<{ id: string }> }

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params
  let project
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
    project = access.project
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project must be active before configuring retention" }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const parsed = retentionUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { keepLastN, tagPattern } = parsed.data

  // The desired state is recorded before the fan-out, so a member that is currently down
  // applies these values — not stale ones — when its queued RETENTION_UPSERT replays.
  const policy = await prisma.retentionPolicy.upsert({
    where: { projectId: id },
    create: { projectId: id, keepLastN, tagPattern },
    update: { keepLastN, tagPattern },
  })

  let summary
  try {
    summary = await syncRetentionAcrossCluster(id, { keepLastN, tagPattern })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update retention policy" },
      { status: 502 }
    )
  }

  if (summary.succeeded === 0) {
    const detail = summary.outcomes.map((o) => `${o.member.registryName}: ${o.error}`).join("; ")
    return NextResponse.json(
      { error: `No Harbor in the cluster accepted the retention policy — ${detail}` },
      { status: 502 }
    )
  }

  return NextResponse.json({
    ...policy,
    placements: {
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: summary.outcomes
        .filter((o) => !o.ok)
        .map((o) => ({ registry: o.member.registryName, error: o.error })),
    },
  })
}
