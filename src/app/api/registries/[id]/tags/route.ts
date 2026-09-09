import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { loadConnection } from "@/lib/registries/load"
import { isValidRepositoryPath, listTags } from "@/lib/registries/v2-client"

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

  const repo = new URL(request.url).searchParams.get("repo")
  if (!repo) return NextResponse.json({ error: "Missing ?repo=" }, { status: 400 })
  if (!isValidRepositoryPath(repo)) {
    return NextResponse.json({ error: "Invalid ?repo= — expected a repository path" }, { status: 400 })
  }

  try {
    const tags = await listTags(conn, repo)
    return NextResponse.json({ repo, tags })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tag list request failed" },
      { status: 502 }
    )
  }
}
