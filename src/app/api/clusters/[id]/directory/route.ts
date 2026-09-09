import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { pickHealthyMember } from "@/lib/clusters/members"
import { searchHarborUsers } from "@/lib/registries/harbor"

// The cluster's own user directory, as one of its Harbors answers it. This is the source the
// member picker draws from when a cluster keeps a directory of its own: the account name has
// to come from Harbor, never from a free-text field, or the mapping this route exists to feed
// would be as guessable — and as wrong — as the assumption it replaces.
//
// ADMIN-gated: it enumerates accounts on a system the caller may have no business browsing,
// and only an ADMIN can write the mapping it serves.
type Params = { params: Promise<{ id: string }> }

const DIRECTORY_PAGE_SIZE = 25

export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? ""

  const member = await pickHealthyMember(id)
  if (!member) {
    return NextResponse.json(
      { error: "No Harbor in this cluster is reachable right now." },
      { status: 503 }
    )
  }

  try {
    // Harbor's search is a substring match and needs something to match on: an empty query
    // returns nothing rather than the whole directory, which is the right default for a
    // directory that may hold tens of thousands of accounts.
    const users = query ? await searchHarborUsers(member.conn, query, DIRECTORY_PAGE_SIZE + 1) : []
    return NextResponse.json({
      registry: member.registryName,
      users: users.slice(0, DIRECTORY_PAGE_SIZE),
      truncated: users.length > DIRECTORY_PAGE_SIZE,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Directory search failed" },
      { status: 502 }
    )
  }
}
