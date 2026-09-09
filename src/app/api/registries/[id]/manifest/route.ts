import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { getHarborArtifactDetail } from "@/lib/registries/harbor"
import { loadConnection } from "@/lib/registries/load"
import { deleteManifest, getManifest, isValidReference, isValidRepositoryPath } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

function getRepoAndReference(request: Request): { repo: string | null; reference: string | null } {
  const params = new URL(request.url).searchParams
  return { repo: params.get("repo"), reference: params.get("reference") }
}

export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const conn = await loadConnection(id)
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { repo, reference } = getRepoAndReference(request)
  if (!repo || !reference) {
    return NextResponse.json({ error: "Missing ?repo= or ?reference=" }, { status: 400 })
  }
  if (!isValidRepositoryPath(repo)) {
    return NextResponse.json({ error: "Invalid ?repo= — expected a repository path" }, { status: 400 })
  }
  // The reference reaches the registry path verbatim (see isValidReference); refusing it here
  // is what turns a crafted value into a 400 rather than a 502 out of the client.
  if (!isValidReference(reference)) {
    return NextResponse.json({ error: "Invalid ?reference= — expected a tag or a digest" }, { status: 400 })
  }

  try {
    // The manifest comes from the OCI API and always exists; the Harbor detail carries what
    // the OCI manifest cannot say — that this is a Helm chart rather than an image, its
    // platform, its scan summary — and is null when Harbor has nothing on it.
    const [manifest, artifact] = await Promise.all([
      getManifest(conn, repo, reference),
      getHarborArtifactDetail(conn, repo, reference),
    ])

    return NextResponse.json({ manifest, artifact })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Manifest request failed" },
      { status: 502 }
    )
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const conn = await loadConnection(id)
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { repo, reference } = getRepoAndReference(request)
  if (!repo || !reference) {
    return NextResponse.json({ error: "Missing ?repo= or ?reference=" }, { status: 400 })
  }
  if (!isValidRepositoryPath(repo)) {
    return NextResponse.json({ error: "Invalid ?repo= — expected a repository path" }, { status: 400 })
  }
  if (!isValidReference(reference)) {
    return NextResponse.json({ error: "Invalid ?reference= — expected a tag or a digest" }, { status: 400 })
  }

  try {
    await deleteManifest(conn, repo, reference)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed" },
      { status: 502 }
    )
  }
}
