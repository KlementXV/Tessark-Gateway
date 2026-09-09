import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, hasRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { loadProjectForAccess } from "@/lib/projects/access"
import { deleteProjectArtifact } from "@/lib/projects/artifacts"
import { listProjectImageArtifacts, listProjectImages, NoSyncedHarborError } from "@/lib/projects/images"
import { isValidDigest, isValidRepositoryPath } from "@/lib/registries/v2-client"

type Params = { params: Promise<{ id: string }> }

// GET /api/projects/[id]/images            → the project's repositories
// GET /api/projects/[id]/images?repo=<name> → the artifacts of one repository
//
// Anyone who may view the project may read this: it is the project's own content, not the
// registry-wide catalog behind /api/registries/[id]/catalog (admin only).
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

  const repo = new URL(request.url).searchParams.get("repo")

  try {
    if (repo) {
      const artifacts = await listProjectImageArtifacts(id, project.name, repo)
      return NextResponse.json({ repo, artifacts })
    }
    return NextResponse.json(await listProjectImages(id, project.name))
  } catch (err) {
    if (err instanceof NoSyncedHarborError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read images from Harbor" },
      { status: 502 }
    )
  }
}

/**
 * DELETE /api/projects/[id]/images?repo=<name>            → the whole repository
 * DELETE /api/projects/[id]/images?repo=<name>&digest=…   → one artifact
 *
 * Standing to delete is standing to *write*, not to view: it takes the owner, a member above
 * GUEST, or a global admin. Deliberately wider than `isManager` — a DEVELOPER pushes the images
 * this removes, and narrower than the read above, which a public project opens to everyone
 * signed in.
 *
 * Only a digest is accepted, never a tag. Harbor's endpoint takes both, but a delete by tag
 * removes the artifact behind it with every other tag it carries — so the caller who meant to
 * drop `:1.26` would silently take `:stable` too. The digest names one object, and the UI shows
 * the tags that go with it before asking.
 */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params

  let project
  let session
  try {
    session = await authenticateRequest(request)
    ;({ project } = await loadProjectForAccess(id, session))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const membership = project.members.find((member) => member.userId === session!.user.id)
  const canWrite =
    hasRole(session, Role.ADMIN) ||
    project.ownerUserId === session!.user.id ||
    (membership !== undefined && membership.role !== "GUEST")
  if (!canWrite) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project is not active yet" }, { status: 409 })
  }

  const url = new URL(request.url)
  const repo = url.searchParams.get("repo")?.trim()
  const digest = url.searchParams.get("digest")?.trim() || null
  if (!repo || !isValidRepositoryPath(repo)) {
    return NextResponse.json({ error: "A repository is required" }, { status: 400 })
  }
  if (digest !== null && !isValidDigest(digest)) {
    return NextResponse.json(
      { error: "An artifact is deleted by digest — a tag would take every other tag of that artifact with it" },
      { status: 400 },
    )
  }

  try {
    const summary = await deleteProjectArtifact(id, project.name, repo, digest)
    // Not reaching a single Harbor is a failed delete, not a partial one: the image is still
    // served everywhere it was. The queued replay stands either way, which is why the body
    // carries it rather than the status code alone.
    const status = summary.deleted > 0 ? 200 : 502
    return NextResponse.json(summary, { status })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete from Harbor" },
      { status: 502 },
    )
  }
}
