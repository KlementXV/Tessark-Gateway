import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { openClusterDirectory, searchDirectoryUsers } from "@/lib/clusters/directory"

// The cluster's own user directory, as one of its Harbors answers it. This is the source the
// member picker draws from when a cluster keeps a directory of its own: the account name has
// to come from Harbor, never from a free-text field, or the mapping this route exists to feed
// would be as guessable — and as wrong — as the assumption it replaces.
//
// Two sources can answer, and the response says which (`source`, and per hit): the LDAP
// directory itself when that Harbor has one configured — people who never signed in to Harbor
// included — or only the accounts Harbor already holds. See src/lib/clusters/directory.ts.
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

  const opened = await openClusterDirectory(id)
  if (!opened) {
    return NextResponse.json(
      { error: "No Harbor in this cluster is reachable right now." },
      { status: 503 }
    )
  }

  try {
    // An empty query returns nothing rather than the whole directory, which is the right
    // default for a directory that may hold tens of thousands of accounts — and Harbor's LDAP
    // search, handed an empty name, returns every one of them.
    const result = await searchDirectoryUsers(opened.member, opened.capability, query, DIRECTORY_PAGE_SIZE)
    return NextResponse.json({ registry: opened.member.registryName, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Directory search failed" },
      { status: 502 }
    )
  }
}
