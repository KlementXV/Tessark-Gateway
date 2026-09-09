import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { clusterInputSchema } from "@/lib/clusters/schema"
import { createCluster, listClustersWithHealth } from "@/lib/clusters/service"

// ADMIN, like GET /api/registries and like the whole /registries UI the fleet view lives in.
// The payload is the registry inventory — every Harbor's URL, the account the Gateway
// authenticates with, its system robot's name, whether its TLS is trusted — which is an
// operator's business and nobody else's. /api/search already withholds exactly this from a
// non-admin; leaving the same rows readable here was the hole in that rule.
export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  return NextResponse.json(await listClustersWithHealth())
}

export async function POST(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = clusterInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    return NextResponse.json(await createCluster(parsed.data), { status: 201 })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A cluster with this name already exists." }, { status: 409 })
    }
    throw err
  }
}
