import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { pickHealthyMember } from "@/lib/clusters/members"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { listHarborUserGroups } from "@/lib/registries/harbor"

// The groups the project's cluster knows. Scoped to the project rather than to the cluster —
// unlike /api/clusters/[id]/directory, which is ADMIN — because choosing a group *is* the
// project grant: whoever may add a member may see the list they would pick from.
type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Params) {
  const { id } = await params
  let clusterId: string
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
    clusterId = access.project.clusterId
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const member = await pickHealthyMember(clusterId)
  if (!member) {
    return NextResponse.json(
      { error: "No Harbor in this cluster is reachable right now." },
      { status: 503 }
    )
  }

  const query = new URL(request.url).searchParams.get("q") ?? ""
  try {
    return NextResponse.json({
      registry: member.registryName,
      groups: await listHarborUserGroups(member.conn, query),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Group search failed" },
      { status: 502 }
    )
  }
}
