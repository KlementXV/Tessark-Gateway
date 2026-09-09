import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { hashPassword } from "@/lib/crypto"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getConfig } from "@/lib/config"
import { LOCAL_AUTH_PROVIDER } from "@/lib/users/profile"
import { toPublicUser } from "@/lib/users/public"
import { userUpdateInputSchema } from "@/lib/users/schema"
import { isLastActiveSuperadmin } from "@/lib/users/superadmin"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const parsed = userUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const isSelf = session!.user.id === id
  if (isSelf && (parsed.data.disabled === true || (parsed.data.role && parsed.data.role !== Role.SUPERADMIN))) {
    return NextResponse.json({ error: "You cannot disable or demote your own account." }, { status: 400 })
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { authProvider: true, role: true, disabled: true },
  })
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 })

  const federated = target.authProvider !== LOCAL_AUTH_PROVIDER

  if (federated && parsed.data.password) {
    return NextResponse.json(
      { error: "This account is managed by an identity provider — it has no Gateway password to set." },
      { status: 400 },
    )
  }

  // With a role mapping configured, the identity provider re-applies the role at every
  // sign-in. Accepting a role change here would look like it worked and then silently
  // revert, so refuse it and say where the change belongs.
  if (federated && parsed.data.role && Object.keys(getConfig().oidcRoleMapping).length > 0) {
    return NextResponse.json(
      { error: "The role of a federated account is derived from its identity provider group — change it there." },
      { status: 400 },
    )
  }

  const losesSuperadmin =
    target.role === Role.SUPERADMIN &&
    !target.disabled &&
    (parsed.data.disabled === true || (parsed.data.role !== undefined && parsed.data.role !== Role.SUPERADMIN))

  if (losesSuperadmin && (await isLastActiveSuperadmin(id))) {
    return NextResponse.json(
      { error: "This is the last active superadmin — promote another account first." },
      { status: 409 },
    )
  }

  const { password, ...data } = parsed.data

  const user = await prisma.user.update({
    where: { id },
    data: { ...data, ...(password ? { passwordHash: hashPassword(password) } : {}) },
  })

  return NextResponse.json(toPublicUser(user))
}

export async function DELETE(request: Request, { params }: Params) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireRole(session, Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  if (session!.user.id === id) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, disabled: true } })
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 })

  if (target.role === Role.SUPERADMIN && !target.disabled && (await isLastActiveSuperadmin(id))) {
    return NextResponse.json(
      { error: "This is the last active superadmin — promote another account first." },
      { status: 409 },
    )
  }

  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
