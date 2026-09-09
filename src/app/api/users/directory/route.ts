import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import { prisma } from "@/lib/prisma"

// How many matches one request returns. The picker searches server-side rather than filtering
// a full dump in the browser, because a directory-backed instance (LDAP) can hold far more
// accounts than are worth shipping to the client — so the cap is a real one, and `truncated`
// tells the picker to ask the user to narrow the search instead of pretending it saw
// everything.
const DIRECTORY_PAGE_SIZE = 25

// Minimal user directory (id/username/name only) — used by project members pickers.
// Any authenticated user can read it; unlike /api/users it exposes no email, role, or
// disabled status and isn't SUPERADMIN-gated.
export async function GET(request: Request) {
  try {
    requireUser(await authenticateRequest(request))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? ""

  // `contains` is case-sensitive on PostgreSQL (unlike SQLite's LIKE) — `mode: "insensitive"`
  // keeps the search matching regardless of casing.
  const where = {
    disabled: false,
    ...(query
      ? {
          OR: [
            { username: { contains: query, mode: "insensitive" as const } },
            { name: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, username: true, name: true },
    orderBy: { username: "asc" },
    take: DIRECTORY_PAGE_SIZE + 1,
  })

  const truncated = users.length > DIRECTORY_PAGE_SIZE
  return NextResponse.json({ users: users.slice(0, DIRECTORY_PAGE_SIZE), truncated })
}
