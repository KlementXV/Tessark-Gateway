import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import { openClusterDirectory, searchDirectoryGroups } from "@/lib/clusters/directory"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"

// The groups the project's cluster knows. Scoped to the project rather than to the cluster —
// unlike /api/clusters/[id]/directory, which is ADMIN — because choosing a group *is* the
// project grant: whoever may add a member may see the list they would pick from.
//
// With `q`, a Harbor that has an LDAP directory configured is also asked for that exact group
// name, so a group Harbor has never registered can be offered; its DN comes from the directory,
// never from a form. `source` says which of the two answered.
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

  const opened = await openClusterDirectory(clusterId)
  if (!opened) {
    return NextResponse.json(
      { error: "No Harbor in this cluster is reachable right now." },
      { status: 503 }
    )
  }

  const query = new URL(request.url).searchParams.get("q") ?? ""
  try {
    const result = await searchDirectoryGroups(opened.member, opened.capability, query)
    return NextResponse.json({ registry: opened.member.registryName, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Group search failed" },
      { status: 502 }
    )
  }
}
