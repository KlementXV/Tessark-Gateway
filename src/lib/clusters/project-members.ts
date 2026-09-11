import { ProjectMemberRole } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  applyHarborProjectMember,
  findHarborProjectIdByName,
  findHarborProjectMember,
  HARBOR_ROLE_DEVELOPER,
  HARBOR_ROLE_GUEST,
  HARBOR_ROLE_PROJECT_ADMIN,
  HarborUnknownUserError,
  removeHarborProjectMember,
  type HarborUnknownUserReason,
} from "@/lib/registries/harbor"
import { recoverUnknownUser } from "./directory"
import { enqueue, fanOut, parsePayload, type MemberOutcome } from "./fanout"
import {
  MissingClusterIdentityError,
  resolveHarborUsername,
  resolveHarborUsernames,
} from "./identity"
import { loadClusterMembers, type ClusterMember } from "./members"

// Project membership is a Harbor concept, not a Gateway one: a ProjectMember row only decides
// what the Gateway UI shows, while the grant that actually lets somebody pull or push lives on
// each Harbor of the cluster. So every membership change is fanned out the same way projects
// and robots are — best effort, with whatever a member missed parked in PendingOperation.
//
// The join key across the two worlds is a username — but *which* username depends on the
// cluster: each one may answer to a directory of its own, so the name is resolved through
// src/lib/clusters/identity.ts rather than read off User.username. Everything below carries
// the resolved name (`harborUsername`), including the queue payloads, so a replay pushes the
// same grant the first attempt did.

export function harborRoleId(role: ProjectMemberRole): number {
  switch (role) {
    case ProjectMemberRole.PROJECT_ADMIN:
      return HARBOR_ROLE_PROJECT_ADMIN
    case ProjectMemberRole.GUEST:
      return HARBOR_ROLE_GUEST
    default:
      return HARBOR_ROLE_DEVELOPER
  }
}

export interface MemberDesiredState {
  projectId: string
  projectName: string
  /** What the cluster's directory calls this person — never the Gateway's User.username. */
  harborUsername: string
  role: ProjectMemberRole
}

// The project's Harbor-side ID on this member. The placement is the cheap path; a name lookup
// covers a member whose placement was never written (an adopted project, or a replay that
// reaches this before the placement row exists).
async function resolveHarborProjectId(
  member: ClusterMember,
  projectId: string,
  projectName: string
): Promise<number | null> {
  const placement = await prisma.projectPlacement.findUnique({
    where: { projectId_registryId: { projectId, registryId: member.registryId } },
    select: { harborProjectId: true },
  })
  if (placement?.harborProjectId) return placement.harborProjectId
  return findHarborProjectIdByName(member.conn, projectName)
}

export async function applyMemberToMember(
  member: ClusterMember,
  desired: MemberDesiredState
): Promise<void> {
  const harborProjectId = await resolveHarborProjectId(
    member,
    desired.projectId,
    desired.projectName
  )
  // The project itself hasn't landed here yet. Its own PROJECT_CREATE is already queued for
  // this member, and that replay pushes the members with it — so this is not an error.
  if (harborProjectId === null) {
    throw new Error(`Project "${desired.projectName}" does not exist on ${member.registryName} yet`)
  }

  const grant = () =>
    applyHarborProjectMember(member.conn, harborProjectId, desired.harborUsername, harborRoleId(desired.role))

  try {
    await grant()
  } catch (err) {
    if (!(err instanceof HarborUnknownUserError)) throw err

    // Asked of this member, since every Harbor holds its own user table (measured, M3): the
    // directory account is imported where the directory allows it and the grant retried once;
    // everywhere else the refusal is qualified, so "unknown user" says whether the account is
    // missing from the directory or simply has not signed in to an OIDC Harbor yet.
    const recovery = await recoverUnknownUser(member, desired.harborUsername)
    if (recovery === "imported") {
      try {
        await grant()
        return
      } catch (retryErr) {
        if (!(retryErr instanceof HarborUnknownUserError)) throw retryErr
      }
    }
    // Rethrown with the member's name attached: "no user clement" is only actionable once you
    // know which Harbor is missing the account.
    throw new HarborUnknownUserError(
      desired.harborUsername,
      member.registryName,
      recovery && recovery !== "imported" ? recovery : undefined
    )
  }
}

export async function removeMemberFromMember(
  member: ClusterMember,
  projectId: string,
  projectName: string,
  username: string
): Promise<void> {
  const harborProjectId = await resolveHarborProjectId(member, projectId, projectName)
  // No project here means no membership to revoke — the desired end state either way.
  if (harborProjectId === null) return

  const existing = await findHarborProjectMember(member.conn, harborProjectId, username)
  if (!existing) return

  await removeHarborProjectMember(member.conn, harborProjectId, existing.id)
}

export interface MemberSyncSummary {
  succeeded: number
  failed: number
  /** Members whose failure is queued for replay, plus the ones reported as-is. */
  failures: Array<{ registry: string; error: string }>
  /** True when no Harbor of the cluster knows the account — the grant is Gateway-only. */
  unknownUserEverywhere: boolean
  /** Why, when every member that refused gave the same reason. */
  unknownUserReason?: HarborUnknownUserReason | null
}

function summarize(outcomes: MemberOutcome<void>[]): MemberSyncSummary {
  const failed = outcomes.filter((o) => !o.ok)
  const unknownUserEverywhere =
    outcomes.length > 0 && failed.length === outcomes.length &&
    failed.every((o) => o.reason instanceof HarborUnknownUserError)
  const reasons = new Set(
    failed.map((o) => (o.reason instanceof HarborUnknownUserError ? o.reason.reason ?? null : null))
  )
  return {
    succeeded: outcomes.length - failed.length,
    failed: failed.length,
    failures: failed.map((o) => ({
      registry: o.member.registryName,
      error: o.error ?? "Unknown error",
    })),
    unknownUserEverywhere,
    unknownUserReason: unknownUserEverywhere && reasons.size === 1 ? [...reasons][0] : null,
  }
}

// Shared by the initial fan-out and by the reconciler's replay, so both drive members from the
// same desired state — the ProjectMember row plus the username it points at.
export async function loadMemberDesiredState(
  projectId: string,
  userId: string
): Promise<{ desired: MemberDesiredState; clusterId: string } | null> {
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { project: { select: { name: true, clusterId: true } } },
  })
  if (!membership) return null

  // Null here means the cluster keeps its own directory and nobody has said what this person
  // is called in it. That is a refusal, not a reason to fall back on User.username: an
  // identically named account in another directory is somebody else.
  const harborUsername = await resolveHarborUsername(userId, membership.project.clusterId)
  if (harborUsername === null) {
    throw new MissingClusterIdentityError(userId, membership.project.clusterId)
  }

  return {
    clusterId: membership.project.clusterId,
    desired: {
      projectId,
      projectName: membership.project.name,
      harborUsername,
      role: membership.role,
    },
  }
}

export async function syncMemberAcrossCluster(
  projectId: string,
  userId: string
): Promise<MemberSyncSummary> {
  const loaded = await loadMemberDesiredState(projectId, userId)
  if (!loaded) throw new Error(`Membership ${userId} on project ${projectId} not found`)
  const { desired, clusterId } = loaded

  const members = await loadClusterMembers(clusterId)
  const outcomes = await fanOut(members, (member) => applyMemberToMember(member, desired))

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    // A Harbor that doesn't know the account will refuse just as firmly on every replay, so it
    // is reported to the caller instead of being queued behind the member's other work.
    if (outcome.reason instanceof HarborUnknownUserError) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "MEMBER_ADD",
      projectId,
      payload: { userId, username: desired.harborUsername },
    })
  }

  return summarize(outcomes)
}

// Revokes the grant on every member of the cluster. Called before the Gateway row goes away,
// so the resolved Harbor name is handed in by the caller and carried by the queued entries —
// by replay time there is nothing left to resolve it from.
export async function removeMemberAcrossCluster(
  projectId: string,
  userId: string,
  harborUsername: string
): Promise<MemberSyncSummary> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, clusterId: true },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const outcomes = await fanOut(members, (member) =>
    removeMemberFromMember(member, projectId, project.name, harborUsername)
  )

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "MEMBER_REMOVE",
      projectId,
      payload: { userId, username: harborUsername, projectName: project.name },
    })
  }

  return summarize(outcomes)
}

// Drops the replay entries queued for one person on one project — used when a membership is
// rolled back, so a member that comes back later doesn't resurrect a grant nobody holds.
export async function forgetQueuedMemberOps(
  projectId: string,
  harborUsername: string
): Promise<void> {
  const queued = await prisma.pendingOperation.findMany({
    where: { projectId, kind: { in: ["MEMBER_ADD", "MEMBER_REMOVE"] } },
  })
  const mine = queued.filter((op) => parsePayload(op.payload).username === harborUsername)
  await prisma.pendingOperation.deleteMany({ where: { id: { in: mine.map((op) => op.id) } } })
}

// Pushes every member of a project onto one Harbor. Used when the project itself lands there —
// a member that was down through the last membership change would otherwise come back with the
// project but none of its grants.
export async function applyProjectMembersToMember(
  member: ClusterMember,
  projectId: string,
  projectName: string
): Promise<void> {
  const memberships = await prisma.projectMember.findMany({ where: { projectId } })
  if (memberships.length === 0) return

  // One resolution pass for the whole project rather than one per membership. A member with
  // no mapped account is simply absent from the map — that grant is left to an admin, exactly
  // as an account Harbor does not know is.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { clusterId: true },
  })
  if (!project) return
  const harborUsernameById = await resolveHarborUsernames(
    memberships.map((m) => m.userId),
    project.clusterId
  )

  for (const membership of memberships) {
    const harborUsername = harborUsernameById.get(membership.userId)
    if (!harborUsername) continue

    try {
      await applyMemberToMember(member, {
        projectId,
        projectName,
        harborUsername,
        role: membership.role,
      })
    } catch (err) {
      // One grant failing must not take the project placement down with it: the project is
      // present, and this single member is queued (or, for an unknown user, left to an admin).
      if (err instanceof HarborUnknownUserError) continue
      await enqueue({
        registryId: member.registryId,
        kind: "MEMBER_ADD",
        projectId,
        payload: { userId: membership.userId, username: harborUsername },
      })
    }
  }
}

/** Preserve existing membership intent when a role update cannot reach the Harbors. */
export async function saveMemberAcrossCluster(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
  harborUsername: string,
) {
  const where = { projectId_userId: { projectId, userId } }
  const previous = await prisma.projectMember.findUnique({ where })
  const member = await prisma.projectMember.upsert({
    where,
    create: { projectId, userId, role },
    update: { role },
  })
  const rollbackCreation = async () => {
    if (previous) return
    await forgetQueuedMemberOps(projectId, harborUsername)
    await prisma.projectMember.delete({ where: { id: member.id } })
  }
  let summary: MemberSyncSummary
  try {
    summary = await syncMemberAcrossCluster(projectId, userId)
  } catch (err) {
    await rollbackCreation()
    throw err
  }
  if (summary.succeeded === 0) await rollbackCreation()
  return { member, summary }
}
