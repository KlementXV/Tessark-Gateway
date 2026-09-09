import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { listCatalog } from "@/lib/registries/v2-client"
import { loadConnection } from "@/lib/registries/load"

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const conn = await loadConnection(id)
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const url = new URL(request.url)
  const n = url.searchParams.get("n")
  const last = url.searchParams.get("last")

  try {
    const result = await listCatalog(conn, {
      n: n ? Number(n) : undefined,
      last: last ?? undefined,
    })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Catalog request failed" },
      { status: 502 }
    )
  }
}
