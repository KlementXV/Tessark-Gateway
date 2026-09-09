import { randomBytes } from "node:crypto"

import { RegistryRole } from "@/generated/prisma/client"
import { encryptSecret, decryptSecret } from "@/lib/crypto"
import { prisma } from "@/lib/prisma"
import {
  createHarborRobotAccount,
  deleteHarborRobotAccount,
  findHarborRobotIdByName,
  setHarborRobotSecret,
} from "@/lib/registries/harbor"
import { enqueue, fanOut, type MemberOutcome } from "./fanout"
import { loadClusterMembers, loadMember, type ClusterMember } from "./members"

// Harbor validates robot secrets against a fixed policy (see clusters/robot-secret.ts): at
// least 8 characters with an uppercase letter, a lowercase letter and a digit. The literal
// prefix guarantees all three character classes regardless of what base64url produces, and
// the random tail carries the actual entropy.
export function generateRobotSecret(): string {
  return `Aa1${randomBytes(24).toString("base64url")}`
}

export interface RobotDesiredState {
  id: string
  name: string
  projectName: string
  secret: string
  expiresInDays?: number | null
}

// Creates (or adopts) the robot on one member and forces its secret to the cluster-wide
// value. Returns false when that Harbor refused the secret PATCH — the caller then knows the
// stored secret no longer works everywhere.
export async function applyRobotToMember(
  member: ClusterMember,
  robot: RobotDesiredState
): Promise<boolean> {
  if (robot.expiresInDays != null && robot.expiresInDays <= 0) {
    throw new Error("Cannot provision an expired robot account")
  }
  const existingId = await findHarborRobotIdByName(member.conn, robot.projectName, robot.name)

  let harborRobotId: number
  let harborIssuedSecret: string | null = null

  if (existingId) {
    harborRobotId = existingId
  } else {
    const created = await createHarborRobotAccount(member.conn, robot.projectName, robot.name, {
      expiresInDays: robot.expiresInDays ?? undefined,
    })
    harborRobotId = created.id
    harborIssuedSecret = created.secret
  }

  const unified = await setHarborRobotSecret(member.conn, harborRobotId, robot.secret)

  // Whatever secret is known to work on this member while it stays out of line. A robot we
  // just created hands us its own; one we are retrying against already has that secret on
  // its placement row. Only a robot that was adopted — created by somebody else, never
  // readable — leaves us with nothing.
  let divergentSecret: string | null = null
  if (!unified) {
    divergentSecret =
      (harborIssuedSecret ? encryptSecret(harborIssuedSecret) : null) ??
      (await knownPlacementSecret(robot.id, member.registryId))

    if (!divergentSecret) {
      throw new Error(
        `${member.registryName} refused to set the robot secret, and the secret of the robot already there cannot be read back`
      )
    }
  }

  await prisma.robotPlacement.upsert({
    where: {
      robotAccountId_registryId: { robotAccountId: robot.id, registryId: member.registryId },
    },
    create: {
      robotAccountId: robot.id,
      registryId: member.registryId,
      harborRobotId,
      encryptedSecret: divergentSecret,
      status: "ACTIVE",
    },
    update: {
      harborRobotId,
      encryptedSecret: divergentSecret,
      status: "ACTIVE",
      lastError: null,
    },
  })

  return unified
}

async function knownPlacementSecret(
  robotAccountId: string,
  registryId: string
): Promise<string | null> {
  const placement = await prisma.robotPlacement.findUnique({
    where: { robotAccountId_registryId: { robotAccountId, registryId } },
    select: { encryptedSecret: true },
  })
  return placement?.encryptedSecret ?? null
}

/**
 * Recomputes `RobotAccount.unifiedSecret` from what the placements actually say.
 *
 * The flag is a summary of observed state, so it has to be derived rather than latched:
 * setting it to false on the first refusal and never looking again left the "secret differs
 * across Harbors" warning up forever, including long after a retry had brought the member
 * back in line.
 */
export async function refreshRobotUnifiedFlag(robotAccountId: string): Promise<boolean> {
  const robot = await prisma.robotAccount.findUnique({
    where: { id: robotAccountId },
    include: { project: { select: { clusterId: true } }, placements: true },
  })
  if (!robot) return true

  // Counted the way loadClusterMembers() selects: a placement only ever exists for a MANAGED
  // member, so counting every registry of the cluster would make `aligned` unreachable — and
  // the "secret differs across Harbors" warning permanent — the day a DELIVERY row sits in
  // one. PATCH /api/registries/[id] refuses that transition today; this keeps the derivation
  // true regardless of which side of that guard changes.
  const memberCount = await prisma.registry.count({
    where: { clusterId: robot.project.clusterId, role: RegistryRole.MANAGED },
  })
  const aligned =
    robot.placements.length === memberCount &&
    robot.placements.every((p) => p.status === "ACTIVE" && p.encryptedSecret === null)

  if (aligned !== robot.unifiedSecret) {
    await prisma.robotAccount.update({ where: { id: robotAccountId }, data: { unifiedSecret: aligned } })
  }
  return aligned
}

/**
 * Re-attempts secret alignment for every robot still out of line on this member.
 *
 * Deliberately not driven by the PendingOperation queue: that queue is head-blocking (see
 * reconcileRegistry), so parking a Harbor that keeps refusing the PATCH in it would stall
 * every later operation for that member. A divergence is already recorded on the placement
 * row, which makes it ordinary observed state — so it is reconciled from there, and simply
 * stays divergent for another pass when the Harbor refuses again.
 */
export async function realignRobotSecrets(member: ClusterMember): Promise<number> {
  const divergent = await prisma.robotPlacement.findMany({
    where: {
      registryId: member.registryId,
      encryptedSecret: { not: null },
      harborRobotId: { not: null },
    },
    include: { robotAccount: true },
  })

  let realigned = 0
  for (const placement of divergent) {
    const secret = decryptSecret(placement.robotAccount.encryptedSecret)
    const ok = await setHarborRobotSecret(member.conn, placement.harborRobotId!, secret).catch(
      () => false
    )
    if (!ok) continue

    await prisma.robotPlacement.update({
      where: { id: placement.id },
      data: { encryptedSecret: null },
    })
    await refreshRobotUnifiedFlag(placement.robotAccountId)
    realigned += 1
  }

  return realigned
}

export interface RobotSyncSummary {
  succeeded: number
  failed: number
  /** False when at least one member kept its own secret — the stored one is not cluster-wide. */
  unified: boolean
  outcomes: MemberOutcome<boolean>[]
}

// Shared by the initial fan-out and by the reconciler's replay, so both drive members from
// exactly the same desired state.
export async function loadRobotDesiredState(
  robotAccountId: string
): Promise<{ desired: RobotDesiredState; clusterId: string } | null> {
  const robot = await prisma.robotAccount.findUnique({
    where: { id: robotAccountId },
    include: { project: true },
  })
  // An expired desired credential must never be recreated as an unlimited one.
  if (!robot || (robot.expiresAt && robot.expiresAt.getTime() <= Date.now())) return null

  return {
    clusterId: robot.project.clusterId,
    desired: {
      id: robot.id,
      name: robot.name,
      projectName: robot.project.name,
      secret: decryptSecret(robot.encryptedSecret),
      expiresInDays: expiresInDays(robot.expiresAt),
    },
  }
}

export async function syncRobotAcrossCluster(robotAccountId: string): Promise<RobotSyncSummary> {
  const robot = await prisma.robotAccount.findUnique({ where: { id: robotAccountId } })
  if (!robot) throw new Error(`Robot account ${robotAccountId} not found`)

  const loaded = await loadRobotDesiredState(robotAccountId)
  if (!loaded) throw new Error(`Robot account ${robotAccountId} not found`)
  const { desired, clusterId } = loaded

  const members = await loadClusterMembers(clusterId)
  const outcomes = await fanOut(members, (member) => applyRobotToMember(member, desired))

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await prisma.robotPlacement.upsert({
      where: {
        robotAccountId_registryId: {
          robotAccountId: robot.id,
          registryId: outcome.member.registryId,
        },
      },
      create: {
        robotAccountId: robot.id,
        registryId: outcome.member.registryId,
        status: "FAILED",
        lastError: outcome.error,
      },
      update: { status: "FAILED", lastError: outcome.error },
    })
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "ROBOT_CREATE",
      projectId: robot.projectId,
      robotAccountId: robot.id,
    })
  }

  // Derived from the placements just written, not from `outcomes` alone — the reconciler
  // updates the same rows later, and both paths must agree on what "unified" means.
  const unified = await refreshRobotUnifiedFlag(robot.id)

  return {
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    unified,
    outcomes,
  }
}

export interface RevokeSummary {
  succeeded: number
  failed: number
}

// Revokes the robot on every member that has it. The RobotAccount row is deleted by the
// caller afterwards, so members that fail get the Harbor ID handed to them in the queued
// payload — by replay time there is no row left to read it from.
export async function revokeRobotAcrossCluster(robotAccountId: string): Promise<RevokeSummary> {
  const robot = await prisma.robotAccount.findUnique({
    where: { id: robotAccountId },
    include: { placements: true },
  })
  if (!robot) throw new Error(`Robot account ${robotAccountId} not found`)

  // A placement with no Harbor ID never landed on that member, so there is nothing to revoke.
  const byRegistry = new Map(
    robot.placements.filter((p) => p.harborRobotId !== null).map((p) => [p.registryId, p])
  )
  const members = (
    await Promise.all([...byRegistry.keys()].map((registryId) => loadMember(registryId)))
  ).filter((m): m is ClusterMember => m !== null)

  const outcomes = await fanOut(members, async (member) => {
    await deleteHarborRobotAccount(member.conn, byRegistry.get(member.registryId)!.harborRobotId!)
  })

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "ROBOT_DELETE",
      projectId: robot.projectId,
      robotAccountId: robot.id,
      payload: { harborRobotId: byRegistry.get(outcome.member.registryId)!.harborRobotId },
    })
  }

  return {
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
  }
}

function expiresInDays(expiresAt: Date | null): number | null {
  if (!expiresAt) return null
  const days = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  return Math.max(0, days)
}
