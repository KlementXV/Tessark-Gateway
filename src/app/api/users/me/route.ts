// The signed-in user's own account. Static segment, so it takes precedence over
// /api/users/[id] — which stays SUPERADMIN-only for administering *other* people.
import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { getUserProfile, updateUserProfile } from "@/lib/users/profile"
import { profileUpdateInputSchema } from "@/lib/users/schema"

export async function GET(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const profile = await getUserProfile(session.user.id)
  if (!profile) return NextResponse.json({ error: "Account not found" }, { status: 404 })
  return NextResponse.json(profile)
}

export async function PATCH(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = profileUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    // Rejects directory-mastered accounts with a 409.
    const profile = await updateUserProfile(session.user.id, parsed.data)
    return NextResponse.json(profile)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
}
