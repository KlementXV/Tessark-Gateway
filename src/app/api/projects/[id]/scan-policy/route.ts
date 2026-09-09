import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { syncScanPolicyAcrossCluster } from "@/lib/clusters/scan-policy"
import { prisma } from "@/lib/prisma"

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({
  autoScan: z.boolean(),
  autoSbom: z.boolean(),
})

// PUT /api/projects/[id]/scan-policy → scan-on-push and SBOM-on-push for the whole cluster.
//
// ADMIN, like the quota and the retention policy: it changes what every Harbor of the cluster
// does with every image pushed to this project, which is not the project manager's call.
export async function PUT(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { autoScan: boolean, autoSbom: boolean }" }, { status: 400 })
  }

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project is not active yet" }, { status: 409 })
  }

  // The desired state is stored before it is pushed, deliberately: a member that refuses or
  // is unreachable gets the operation queued, and the reconciler replays it from this row.
  // Storing only on success would leave the queue replaying a policy nobody can read.
  await prisma.project.update({
    where: { id },
    data: { autoScan: parsed.data.autoScan, autoSbom: parsed.data.autoSbom },
  })

  try {
    const summary = await syncScanPolicyAcrossCluster(id, parsed.data)
    return NextResponse.json({
      autoScan: parsed.data.autoScan,
      autoSbom: parsed.data.autoSbom,
      succeeded: summary.succeeded,
      failed: summary.failed,
      // Named, not counted: "SBOM generation is not available on harbor-paris" is actionable,
      // "1 member partially applied" is not.
      sbomUnsupported: summary.sbomUnsupported,
      errors: summary.outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => ({ registryName: outcome.member.registryName, error: outcome.error })),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to push the scan policy" },
      { status: 502 }
    )
  }
}
