import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import { countUnreadNotifications, listNotifications } from "@/lib/notifications/service"

// Always scoped to the caller — a notification has exactly one recipient and there is no
// route, at any role, that reads somebody else's.
export async function GET(request: Request) {
  let session
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const [items, unread] = await Promise.all([
    listNotifications(session.user.id),
    countUnreadNotifications(session.user.id),
  ])

  return NextResponse.json({ items, unread })
}
