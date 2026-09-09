import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { generateRobotSecret, syncRobotAcrossCluster } from "@/lib/clusters/robots"
import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"
import { robotCreateInputSchema } from "@/lib/projects/schema"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id } = await params

  let session: Session | null
  let project
  try {
    session = await authenticateRequest(request)
    const access = await loadProjectForAccess(id, session)
    requireManager(access.isManager)
    project = access.project
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (project.status !== "ACTIVE") {
    return NextResponse.json({ error: "Project must be active before creating robot accounts" }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const parsed = robotCreateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null

  // Either way the secret is chosen on this side rather than letting each Harbor mint its
  // own, so the single credential returned below authenticates against every member — a
  // user-supplied one just skips the generator. The row is written first because the fan-out
  // reads its desired state back out of the database, exactly as a queued replay does later.
  const secret = parsed.data.secret ?? generateRobotSecret()

  let robot
  try {
    robot = await prisma.robotAccount.create({
      data: {
        projectId: id,
        name: parsed.data.name,
        encryptedSecret: encryptSecret(secret),
        expiresAt,
        createdByUserId: session!.user.id,
      },
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A robot with this name already exists." }, { status: 409 })
    }
    throw err
  }

  let summary
  try {
    summary = await syncRobotAcrossCluster(robot.id)
  } catch (err) {
    await prisma.robotAccount.delete({ where: { id: robot.id } })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create robot account" },
      { status: 502 }
    )
  }

  // Nothing landed anywhere, so there is no usable credential to hand back — drop the row
  // and the replay entries rather than leave a robot that exists only in the Gateway.
  if (summary.succeeded === 0) {
    const detail = summary.outcomes.map((o) => `${o.member.registryName}: ${o.error}`).join("; ")
    await prisma.pendingOperation.deleteMany({ where: { robotAccountId: robot.id } })
    await prisma.robotAccount.delete({ where: { id: robot.id } })
    return NextResponse.json(
      { error: `No Harbor in the cluster accepted the robot account — ${detail}` },
      { status: 502 }
    )
  }

  // A member that refused the alignment PATCH kept the secret Harbor minted for it, and that
  // is the only credential that works there. It is handed over here alongside the main one:
  // this response is the single moment any of these are visible, so leaving it out would
  // mean shipping a robot the user cannot actually authenticate with on that Harbor.
  const memberSecrets = summary.unified ? [] : await divergentMemberSecrets(robot.id)

  // The secret is only ever returned here, right after creation — it cannot be retrieved
  // again afterward (Harbor doesn't store it in plaintext either).
  return NextResponse.json(
    {
      id: robot.id,
      name: robot.name,
      secret,
      // False means at least one Harbor kept its own secret, so this one is not cluster-wide.
      unifiedSecret: summary.unified,
      memberSecrets,
      placements: {
        succeeded: summary.succeeded,
        failed: summary.failed,
        failures: summary.outcomes
          .filter((o) => !o.ok)
          .map((o) => ({ registry: o.member.registryName, error: o.error })),
      },
    },
    { status: 201 }
  )
}

/** The per-Harbor credentials for members that kept their own secret, decrypted for the
 *  one-shot reveal above. */
async function divergentMemberSecrets(
  robotAccountId: string
): Promise<{ registry: string; secret: string }[]> {
  const placements = await prisma.robotPlacement.findMany({
    where: { robotAccountId, encryptedSecret: { not: null } },
    include: { registry: { select: { name: true } } },
    orderBy: { registry: { name: "asc" } },
  })

  return placements.map((placement) => ({
    registry: placement.registry.name,
    secret: decryptSecret(placement.encryptedSecret!),
  }))
}
