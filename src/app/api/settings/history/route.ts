import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { getHistoryRetentionDays, purgeHistory, setHistoryRetentionDays } from "@/lib/history/retention"
import { historySettingsInputSchema } from "@/lib/settings/schema"

// Instance-wide data retention, so SUPERADMIN like the rest of InstanceSettings: this decides
// what disappears for *every* user, and it cannot be undone once a purge has run.

export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  return NextResponse.json({ historyRetentionDays: await getHistoryRetentionDays() })
}

export async function PUT(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = historySettingsInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const historyRetentionDays = await setHistoryRetentionDays(parsed.data.historyRetentionDays)

  // Applied immediately rather than on the next page load: shortening the window is an
  // instruction, and an admin who has just cut it to 7 days should see the effect said out
  // loud — the counts come back in the response — instead of wondering whether it took.
  const purged = await purgeHistory()

  return NextResponse.json({ historyRetentionDays, purged })
}
