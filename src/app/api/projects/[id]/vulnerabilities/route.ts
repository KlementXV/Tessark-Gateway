import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { loadProjectForAccess } from "@/lib/projects/access"
import { getProjectImageVulnerabilities, NoSyncedHarborError } from "@/lib/projects/images"
import { isValidReference } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

// GET /api/projects/[id]/vulnerabilities?repo=<name>&reference=<tag|digest>
//   → the full CVE list Harbor holds for one artifact of this project.
//
// Same access rule as /api/projects/[id]/images — it is the project's own content — and split
// off for the same reason /api/registries/[id]/vulnerabilities is: a report is hundreds of
// rows, fetched only when a viewer asks to see them.
export async function GET(request: Request, { params }: Params) {
  const { id } = await params

  let project
  try {
    ;({ project } = await loadProjectForAccess(id, await authenticateRequest(request)))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project is not active yet" }, { status: 409 })
  }

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
    const vulnerabilities = await getProjectImageVulnerabilities(id, project.name, repo, reference)
    return NextResponse.json({ vulnerabilities })
  } catch (err) {
    if (err instanceof NoSyncedHarborError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Vulnerability request failed" },
      { status: 502 }
    )
  }
}
