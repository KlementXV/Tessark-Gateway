import { invalidateProjectBuilds, withBuildLock } from "@/lib/builds/service"
import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import {
  generateRobotSecret,
  revokeRobotAcrossCluster,
  syncRobotAcrossCluster,
} from "@/lib/clusters/robots"
import { encryptSecret } from "@/lib/crypto"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"
import { robotSecretRotateInputSchema } from "@/lib/projects/schema"

type Params = { params: Promise<{ id: string; robotId: string }> }

/**
 * Rotates the robot's secret — a new one is pushed onto every member, replacing what is
 * there. Same shape as creation: supply a secret or let the Gateway generate one, and the
 * result is revealed exactly once.
 */
async function patchRobot(request: Request, { params }: Params) {
  const { id, robotId } = await params
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const robot = await prisma.robotAccount.findUnique({ where: { id: robotId } })
  if (!robot || robot.projectId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const parsed = robotSecretRotateInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  await invalidateProjectBuilds(id, "Project robot credentials changed; reapply this build")
  const secret = parsed.data.secret ?? generateRobotSecret()
  const previousSecret = robot.encryptedSecret

  // Written before the fan-out for the same reason as at creation: every member — and every
  // later replay — reads its desired state back out of this row.
  await prisma.robotAccount.update({
    where: { id: robotId },
    data: { encryptedSecret: encryptSecret(secret) },
  })

  let summary
  try {
    summary = await syncRobotAcrossCluster(robotId)
  } catch (err) {
    await prisma.robotAccount.update({ where: { id: robotId }, data: { encryptedSecret: previousSecret } })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to rotate the secret" },
      { status: 502 }
    )
  }

  // Nothing took the new secret, so every member still answers to the old one. Putting it
  // back keeps the stored credential the one that actually works, rather than leaving a
  // robot whose recorded secret opens nothing.
  if (summary.succeeded === 0) {
    await prisma.robotAccount.update({ where: { id: robotId }, data: { encryptedSecret: previousSecret } })
    const detail = summary.outcomes.map((o) => `${o.member.registryName}: ${o.error}`).join("; ")
    return NextResponse.json(
      { error: `No Harbor accepted the new secret — ${detail}. The previous one is still in effect.` },
      { status: 502 }
    )
  }

  return NextResponse.json({
    id: robot.id,
    name: robot.name,
    secret,
    unifiedSecret: summary.unified,
    // A member that refused the rotation is still on the previous secret, which Harbor never
    // reveals — so unlike at creation there is nothing to hand over for it. It carries a
    // queued retry instead, and shows up under `placements.failures`.
    memberSecrets: [],
    placements: {
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: summary.outcomes
        .filter((o) => !o.ok)
        .map((o) => ({ registry: o.member.registryName, error: o.error })),
    },
  })
}

async function deleteRobot(request: Request, { params }: Params) {
  const { id, robotId } = await params
  try {
    const access = await loadProjectForAccess(id, await authenticateRequest(request))
    requireManager(access.isManager)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const robot = await prisma.robotAccount.findUnique({ where: { id: robotId } })
  if (!robot || robot.projectId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await invalidateProjectBuilds(id, "Project robot revoked; reapply with another robot")
  let summary
  try {
    summary = await revokeRobotAcrossCluster(robotId)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to revoke robot account" },
      { status: 502 }
    )
  }

  // The row goes regardless of unreachable members: revoking a credential must not be blocked
  // by a Harbor being down. Each member that failed carries a queued ROBOT_DELETE holding its
  // own Harbor robot ID, so the credential is withdrawn there as soon as it answers again.
  await prisma.robotAccount.delete({ where: { id: robotId } })

  return NextResponse.json({ ok: true, revoked: summary.succeeded, queued: summary.failed })
}

export async function PATCH(request: Request, context: Params) {
  try { return await withBuildLock(() => patchRobot(request, context)) }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: "Robot rotation could not suspend affected builds" }, { status: 502 }) }
}
export async function DELETE(request: Request, context: Params) {
  try { return await withBuildLock(() => deleteRobot(request, context)) }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: "Robot revocation could not suspend affected builds" }, { status: 502 }) }
}
