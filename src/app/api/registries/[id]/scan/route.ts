import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { RegistryRole, Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { requestHarborScan } from "@/lib/registries/harbor"
import { loadConnection } from "@/lib/registries/load"
import { isValidReference } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({
  repo: z.string().min(1),
  reference: z.string().min(1),
  scanType: z.enum(["vulnerability", "sbom"]),
})

// POST /api/registries/[id]/scan → (re)scan one artifact on this registry, or generate its SBOM.
//
// Registry-wide counterpart of /api/projects/[id]/scan. Refused on a DELIVERY registry: the
// Gateway reads those and pushes images to them, it does not spend their compute or drive
// their scanner — that Harbor belongs to someone else's team.
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

  const registry = await prisma.registry.findUnique({ where: { id }, select: { role: true } })
  if (!registry) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (registry.role === RegistryRole.DELIVERY) {
    return NextResponse.json(
      { error: "Scans cannot be triggered on a delivery registry" },
      { status: 409 }
    )
  }

  const conn = await loadConnection(id)
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 })

  try {
    await requestHarborScan(conn, parsed.data.repo, parsed.data.reference, parsed.data.scanType)
    return NextResponse.json({ ok: true }, { status: 202 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan request failed" },
      { status: 502 }
    )
  }
}
