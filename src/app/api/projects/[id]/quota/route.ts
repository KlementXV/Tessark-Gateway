import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { readQuotaUsageAcrossCluster } from "@/lib/clusters/quota"
import { Role } from "@/generated/prisma/client"
import { loadProjectForAccess } from "@/lib/projects/access"
import { QuotaUpdateError, applyProjectQuota } from "@/lib/projects/quota"
import { quotaUpdateInputSchema } from "@/lib/projects/schema"

type Params = { params: Promise<{ id: string }> }

// Live consumption per Harbor, for anyone who may see the project: knowing how full a
// project is doesn't reveal anything its member list doesn't already give away, and it is
// what makes the limit meaningful. Changing it is another matter — see PUT.
export async function GET(request: Request, { params }: Params) {
  const { id } = await params
  let project
  try {
    ;({ project } = await loadProjectForAccess(id, await authenticateRequest(request)))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (project.status !== "ACTIVE") {
    return NextResponse.json({ storageQuotaMib: project.storageQuotaMib, members: [] })
  }

  try {
    return NextResponse.json({
      storageQuotaMib: project.storageQuotaMib,
      members: await readQuotaUsageAcrossCluster(id),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read quota usage" },
      { status: 502 }
    )
  }
}

// Admins only. A quota is an allocation of shared storage across projects, so it is not the
// project's own manager's call — the same stance Harbor takes, where quotas sit under system
// administration rather than project settings. A manager who needs a different limit raises a
// QuotaRequest instead (POST ./quota/requests), which an admin approves through this very
// same applyProjectQuota().
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.ADMIN)
    await loadProjectForAccess(id, session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = quotaUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    return NextResponse.json(await applyProjectQuota(id, parsed.data.storageQuotaMib))
  } catch (err) {
    if (err instanceof QuotaUpdateError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
