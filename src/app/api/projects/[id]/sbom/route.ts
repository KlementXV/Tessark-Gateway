import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { loadProjectForAccess } from "@/lib/projects/access"
import { getProjectImageSbom, NoSyncedHarborError } from "@/lib/projects/images"
import { isValidReference } from "@/lib/registries/v2-client"
import { sbomFilename } from "@/lib/registries/sbom"

type Params = { params: Promise<{ id: string }> }

// GET /api/projects/[id]/sbom?repo=<name>&reference=<tag|digest>
//   → the artifact's SBOM, as a downloadable CycloneDX JSON file.
//
// Same access rule as /api/projects/[id]/images: it describes the project's own content. The
// document is streamed back untouched — the Gateway does not read SBOMs, it hands them over.
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
    const sbom = await getProjectImageSbom(id, project.name, repo, reference)
    if (!sbom) {
      // Also the honest answer for a multi-arch index: Harbor records the scan as successful
      // but writes no sbom_digest, so there is no document to hand over.
      return NextResponse.json({ error: "No SBOM for this artifact" }, { status: 404 })
    }

    return new NextResponse(JSON.stringify(sbom.document), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${sbomFilename(repo, reference, sbom.format)}"`,
      },
    })
  } catch (err) {
    if (err instanceof NoSyncedHarborError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "SBOM request failed" },
      { status: 502 }
    )
  }
}
