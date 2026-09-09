import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { loginContentInputSchema } from "@/lib/settings/schema"
import { getLoginContent, updateLoginContent } from "@/lib/settings/service"

export async function GET() {
  return NextResponse.json(await getLoginContent())
}

export async function PATCH(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = loginContentInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // No revalidatePath: the root layout forces every route dynamic, so /login re-reads
  // this row on the next request.
  return NextResponse.json(await updateLoginContent(parsed.data))
}
