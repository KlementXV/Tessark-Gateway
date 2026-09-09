import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { transferRuleInputSchema } from "@/lib/transfers/rule-schema"
import { createTransferRule, listTransferRules } from "@/lib/transfers/rule-service"

// SUPERADMIN, not ADMIN: these rules are the policy that decides what may leave the estate,
// which is a different kind of decision from approving one transfer under it. An admin
// reviews requests; only an owner changes the rules those reviews are made against.
export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  return NextResponse.json(await listTransferRules())
}

export async function POST(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = transferRuleInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    return NextResponse.json(await createTransferRule(parsed.data), { status: 201 })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A rule with this name already exists." }, { status: 409 })
    }
    throw err
  }
}
