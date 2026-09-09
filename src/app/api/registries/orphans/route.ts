import { prisma } from "@/lib/prisma"
import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { deleteHarborOrphans, findHarborOrphans } from "@/lib/registries/orphans"

// GET is a read-only sweep of every managed Harbor; DELETE removes named objects from one of
// them. ADMIN for both — this is fleet repair, the same authority as resyncing a mesh.

export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const clusterId = new URL(request.url).searchParams.get("clusterId") ?? undefined
  return NextResponse.json({
    registries: await findHarborOrphans(clusterId),
    pendingReplicationCleanup: await prisma.replicationCleanup.findMany({
      select: { id: true, sourceRegistryId: true, destRegistryId: true, attempts: true, nextAttemptAt: true, lastError: true },
      orderBy: { createdAt: "asc" },
    }),
  })
}

// The objects to remove are passed back verbatim from a scan rather than re-derived here: the
// operator confirms a list they were shown, and a second scan could have drifted from it.
const bodySchema = z.object({
  registryId: z.string().min(1),
  orphans: z
    .array(
      z.object({
        kind: z.enum(["meshPolicy", "meshEndpoint", "mirrorPolicy", "mirrorEndpoint"]),
        harborId: z.number().int(),
        name: z.string().min(1),
        referencedId: z.string(),
        enabled: z.boolean().nullable(),
      }),
    )
    .min(1),
})

export async function DELETE(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "A registryId and a non-empty orphan list are required" }, { status: 400 })
  }

  try {
    const result = await deleteHarborOrphans(parsed.data.registryId, parsed.data.orphans)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cleanup failed" },
      { status: 502 },
    )
  }
}
