import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { moveProjectToCluster, type MoveRefusal } from "@/lib/clusters/move-project"

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({ clusterId: z.string().min(1) })

// ADMIN, not the project's manager: moving a project deletes it on one set of Harbors and
// recreates it on another, which is fleet surgery rather than managing a project's contents.
//
// Error bodies stay English — machine contract, see CLAUDE.md. The UI translates on the
// `code`, which is why each refusal carries one alongside the sentence.
function refusalResponse(refusal: MoveRefusal): NextResponse {
  switch (refusal.code) {
    case "projectNotFound":
      return NextResponse.json({ error: "Project not found", code: refusal.code }, { status: 404 })
    case "clusterNotFound":
      return NextResponse.json({ error: "Cluster not found", code: refusal.code }, { status: 404 })
    case "sameCluster":
      return NextResponse.json(
        { error: "This project is already in that cluster", code: refusal.code },
        { status: 400 },
      )
    case "nameTaken":
      return NextResponse.json(
        {
          error: "Another project of the same name already exists in the target cluster.",
          code: refusal.code,
        },
        { status: 409 },
      )
    case "notEmpty": {
      const detail = refusal.members.map((m) => `${m.registryName} (${m.repoCount})`).join(", ")
      return NextResponse.json(
        {
          error: `This project still holds repositories on ${detail}. Moving deletes it on its current Harbors, so it has to be empty first — the images are not copied.`,
          code: refusal.code,
          members: refusal.members,
        },
        { status: 409 },
      )
    }
    case "unmappedMembers": {
      const names = refusal.users.map((u) => u.username).join(", ")
      return NextResponse.json(
        {
          error: `The target cluster keeps its own user directory and these members have no account mapped in it: ${names}. Map them on that cluster first.`,
          code: refusal.code,
          users: refusal.users,
        },
        { status: 409 },
      )
    }
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "A target clusterId is required" }, { status: 400 })
  }

  let result
  try {
    result = await moveProjectToCluster(id, parsed.data.clusterId)
  } catch (err) {
    const authError = authErrorResponse(err)
    if (authError) return authError
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to move the project" },
      { status: 502 },
    )
  }

  if (!result.ok) return refusalResponse(result.refusal)
  return NextResponse.json({ ok: true, ...result.summary })
}
