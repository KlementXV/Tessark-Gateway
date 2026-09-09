import { NextResponse } from "next/server"
import { z } from "zod"

import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import { markAllNotificationsRead, markNotificationRead } from "@/lib/notifications/service"

// One route for both "I read this one" and "clear the badge": the id is what distinguishes
// them, and an empty body is the natural spelling of "all of mine".
const readInputSchema = z.object({ id: z.string().min(1).optional() })

export async function POST(request: Request) {
  let session
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = readInputSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  if (parsed.data.id) await markNotificationRead(session.user.id, parsed.data.id)
  else await markAllNotificationsRead(session.user.id)

  return NextResponse.json({ ok: true })
}
