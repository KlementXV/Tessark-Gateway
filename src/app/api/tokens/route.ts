import { NextResponse } from "next/server"

import { apiTokenCreateInputSchema } from "@/lib/api-tokens/schema"
import { createApiToken, listTokensForUser } from "@/lib/api-tokens/service"
import { toPublicApiToken } from "@/lib/api-tokens/public"
import { authenticateRequest, authErrorResponse, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"

export async function GET(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const tokens = await listTokensForUser(session.user.id)
  return NextResponse.json(tokens.map(toPublicApiToken))
}

export async function POST(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = apiTokenCreateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const { record, token } = await createApiToken(session.user.id, parsed.data)
    // The only response that ever carries the token in the clear — see toPublicApiToken.
    return NextResponse.json({ ...toPublicApiToken(record), token }, { status: 201 })
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
}
