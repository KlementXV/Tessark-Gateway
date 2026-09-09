// Provisioning of this Harbor's Gateway push robot, out of band from a pull.
//
// Pulls provision it on demand (src/lib/clusters/system-robot.ts), so these routes exist for
// the two things a pull cannot do: check the credential ahead of time, and rotate it. The
// secret itself is never returned — nothing outside the skopeo Job ever needs to read it.
import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { getConfig } from "@/lib/config"
import { forgetSystemRobot, syncSystemRobot, SystemRobotError } from "@/lib/clusters/system-robot"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (!getConfig().systemRobotEnabled) {
    return NextResponse.json({ error: "The Gateway system robot is disabled by configuration" }, { status: 409 })
  }

  const { id } = await params
  const registry = await prisma.registry.findUnique({ where: { id }, select: { id: true } })
  if (!registry) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Rotating means provisioning a new secret over whatever is stored, so the stale row is
  // dropped first: a provision that fails halfway must not leave credentials that no longer
  // authenticate presented as current.
  await forgetSystemRobot(id)

  try {
    const credentials = await syncSystemRobot(id)
    if (!credentials) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ name: credentials.username })
  } catch (err) {
    const message =
      err instanceof SystemRobotError || err instanceof Error
        ? err.message
        : "Failed to provision the system robot"
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const registry = await prisma.registry.findUnique({ where: { id }, select: { id: true } })
  if (!registry) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await forgetSystemRobot(id)
  return NextResponse.json({ ok: true })
}
