import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { NoSyncedHarborError, requestProjectImageScan } from "@/lib/projects/images"
import { prisma } from "@/lib/prisma"
import { isValidReference } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({
  repo: z.string().min(1),
  reference: z.string().min(1),
  scanType: z.enum(["vulnerability", "sbom"]),
})

// POST /api/projects/[id]/scan → (re)scan one artifact, or generate its SBOM.
//
// ADMIN rather than project-member: reading a report is looking at the project's own content,
// but triggering a scan spends CPU on every Harbor of the cluster and can be repeated at will.
// The buttons are hidden for everyone else, so this guard is the one that actually holds.
export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { repo, reference, scanType: 'vulnerability' | 'sbom' }" },
      { status: 400 }
    )
  }
  if (!isValidReference(parsed.data.reference)) {
    return NextResponse.json({ error: "Invalid reference — expected a tag or a digest" }, { status: 400 })
  }

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project is not active yet" }, { status: 409 })
  }

  try {
    const result = await requestProjectImageScan(
      id,
      project.name,
      parsed.data.repo,
      parsed.data.reference,
      parsed.data.scanType
    )
    // 202: Harbor accepted the request and will do the work on its own schedule. There is
    // nothing to report about the result yet — the UI polls scan_overview for that.
    return NextResponse.json(result, { status: 202 })
  } catch (err) {
    if (err instanceof NoSyncedHarborError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan request failed" },
      { status: 502 }
    )
  }
}
