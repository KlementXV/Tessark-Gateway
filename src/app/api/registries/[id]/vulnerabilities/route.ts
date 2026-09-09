import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { getHarborArtifactVulnerabilities } from "@/lib/registries/harbor"
import { loadConnection } from "@/lib/registries/load"
import { isValidReference } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

// GET /api/registries/[id]/vulnerabilities?repo=<name>&reference=<tag|digest>
//   → the full CVE list Harbor holds for one artifact.
//
// Split from the manifest route because it is the expensive half: a report is hundreds of
// rows, and the tag detail panel opens without it — this is fetched only when the user asks
// to see the CVEs.
export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const conn = await loadConnection(id)
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const search = new URL(request.url).searchParams
  const repo = search.get("repo")
  const reference = search.get("reference")
  if (!repo || !reference) {
    return NextResponse.json({ error: "Missing ?repo= or ?reference=" }, { status: 400 })
  }
  if (!isValidReference(reference)) {
    return NextResponse.json({ error: "Invalid ?reference= — expected a tag or a digest" }, { status: 400 })
  }

  try {
    // Null (not a Harbor, never scanned, scanner without an additions report) and [] (scanned,
    // clean) are both legitimate — the client renders "no report" for null, "no findings" for
    // the empty list.
    const vulnerabilities = await getHarborArtifactVulnerabilities(conn, repo, reference)
    return NextResponse.json({ vulnerabilities })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Vulnerability request failed" },
      { status: 502 }
    )
  }
}
