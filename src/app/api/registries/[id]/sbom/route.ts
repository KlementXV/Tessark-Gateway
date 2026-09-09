import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { getHarborArtifactSbom } from "@/lib/registries/harbor"
import { loadConnection } from "@/lib/registries/load"
import { sbomFilename } from "@/lib/registries/sbom"
import { isValidReference } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

// GET /api/registries/[id]/sbom?repo=<name>&reference=<tag|digest>
//   → the artifact's SBOM, as a downloadable CycloneDX JSON file.
//
// Registry-wide counterpart of /api/projects/[id]/sbom, ADMIN like the rest of the fleet
// catalog. Both hand the document over untouched.
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
    const sbom = await getHarborArtifactSbom(conn, repo, reference)
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "SBOM request failed" },
      { status: 502 }
    )
  }
}
