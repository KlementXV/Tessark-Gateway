import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { ProjectDeleteError, deleteProjectEverywhere } from "@/lib/projects/delete"

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params) {
  const { id } = await params
  try {
    const { project, isManager } = await loadProjectForAccess(id, await authenticateRequest(request))
    return NextResponse.json({ ...project, isManager })
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params
  try {
    const { isManager } = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(isManager)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  // Every check and every fan-out lives in deleteProjectEverywhere(), which is also what an
  // approved deletion request runs: the two doors to this must not drift apart.
  try {
    const summary = await deleteProjectEverywhere(id)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    if (err instanceof ProjectDeleteError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
