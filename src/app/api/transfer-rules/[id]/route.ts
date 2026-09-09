import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { transferRuleUpdateInputSchema } from "@/lib/transfers/rule-schema"
import { deleteTransferRule, updateTransferRule } from "@/lib/transfers/rule-service"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = transferRuleUpdateInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const rule = await updateTransferRule((await params).id, parsed.data)
    if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json(rule)
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A rule with this name already exists." }, { status: 409 })
    }
    throw err
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const removed = await deleteTransferRule((await params).id)
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
