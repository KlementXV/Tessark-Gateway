import { ProjectMemberRole } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  applyHarborProjectGroupMember,
  findHarborProjectGroupMember,
  findHarborProjectIdByName,
  HarborUnknownGroupError,
  removeHarborProjectMember,
} from "@/lib/registries/harbor"
import { enqueue, fanOut, parsePayload, type MemberOutcome } from "./fanout"
import { loadClusterMembers, type ClusterMember } from "./members"
import { harborRoleId, type MemberSyncSummary } from "./project-members"

// The group half of project membership. It is the same fan-out as project-members.ts, with one
// difference that runs through everything below: a group needs no identity mapping. The name
// is the group as the cluster's directory spells it, it means the same thing on every Harbor
// of that cluster, and the Gateway never has to know who is in it.
//
// That last point is also the limit: a group grant gives access on the Harbors without making
// anyone a member in the Gateway, so nothing here feeds loadProjectForAccess(). See
// ProjectGroupMember in the Prisma schema.

export interface GroupDesiredState {
  projectId: string
  projectName: string
  groupName: string
  role: ProjectMemberRole
}

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

export async function applyGroupToMember(
  member: ClusterMember,
  desired: GroupDesiredState
): Promise<void> {
  const harborProjectId = await resolveHarborProjectId(
    member,
    desired.projectId,
    desired.projectName
  )
  // The project hasn't landed here yet; its own PROJECT_CREATE replay pushes the groups with
  // it, so this is not an error.
  if (harborProjectId === null) {
    throw new Error(`Project "${desired.projectName}" does not exist on ${member.registryName} yet`)
  }

  try {
    await applyHarborProjectGroupMember(
      member.conn,
      harborProjectId,
      desired.groupName,
      harborRoleId(desired.role)
    )
  } catch (err) {
    // Rethrown with the member's name: "no group devs" is only actionable once you know which
    // Harbor is missing it — a directory is per-cluster, but a group can be registered on one
    // member and not yet on another.
    if (err instanceof HarborUnknownGroupError) {
      throw new HarborUnknownGroupError(desired.groupName, member.registryName)
    }
    throw err
  }
}

export async function removeGroupFromMember(
  member: ClusterMember,
  projectId: string,
  projectName: string,
  groupName: string
): Promise<void> {
  const harborProjectId = await resolveHarborProjectId(member, projectId, projectName)
  if (harborProjectId === null) return

  const existing = await findHarborProjectGroupMember(member.conn, harborProjectId, groupName)
  if (!existing) return

  await removeHarborProjectMember(member.conn, harborProjectId, existing.id)
}

function summarize(outcomes: MemberOutcome<void>[]): MemberSyncSummary {
  const failed = outcomes.filter((o) => !o.ok)
  return {
    succeeded: outcomes.length - failed.length,
    failed: failed.length,
    failures: failed.map((o) => ({
      registry: o.member.registryName,
      error: o.error ?? "Unknown error",
    })),
    unknownUserEverywhere:
      outcomes.length > 0 &&
      failed.length === outcomes.length &&
      failed.every((o) => o.reason instanceof HarborUnknownGroupError),
  }
}

export async function loadGroupDesiredState(
  projectId: string,
  groupName: string
): Promise<{ desired: GroupDesiredState; clusterId: string } | null> {
  const row = await prisma.projectGroupMember.findUnique({
    where: { projectId_groupName: { projectId, groupName } },
    include: { project: { select: { name: true, clusterId: true } } },
  })
  if (!row) return null

  return {
    clusterId: row.project.clusterId,
    desired: {
      projectId,
      projectName: row.project.name,
      groupName: row.groupName,
      role: row.role,
    },
  }
}

export async function syncGroupAcrossCluster(
  projectId: string,
  groupName: string
): Promise<MemberSyncSummary> {
  const loaded = await loadGroupDesiredState(projectId, groupName)
  if (!loaded) throw new Error(`Group ${groupName} on project ${projectId} not found`)
  const { desired, clusterId } = loaded

  const members = await loadClusterMembers(clusterId)
  const outcomes = await fanOut(members, (member) => applyGroupToMember(member, desired))

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    // A Harbor that doesn't hold the group refuses just as firmly on every replay.
    if (outcome.reason instanceof HarborUnknownGroupError) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "GROUP_ADD",
      projectId,
      payload: { groupName },
    })
  }

  return summarize(outcomes)
}

export async function removeGroupAcrossCluster(
  projectId: string,
  groupName: string
): Promise<MemberSyncSummary> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, clusterId: true },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const outcomes = await fanOut(members, (member) =>
    removeGroupFromMember(member, projectId, project.name, groupName)
  )

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "GROUP_REMOVE",
      projectId,
      payload: { groupName, projectName: project.name },
    })
  }

  return summarize(outcomes)
}

// Drops the replay entries queued for one group on one project — used when a grant is rolled
// back, so a member that comes back later doesn't resurrect it.
export async function forgetQueuedGroupOps(
  projectId: string,
  groupName: string
): Promise<void> {
  const queued = await prisma.pendingOperation.findMany({
    where: { projectId, kind: { in: ["GROUP_ADD", "GROUP_REMOVE"] } },
  })
  const mine = queued.filter((op) => parsePayload(op.payload).groupName === groupName)
  await prisma.pendingOperation.deleteMany({ where: { id: { in: mine.map((op) => op.id) } } })
}

// Pushes every group grant of a project onto one Harbor, alongside its individual members —
// same reason: a member that was down through the last change would otherwise come back with
// the project but none of its grants.
export async function applyProjectGroupsToMember(
  member: ClusterMember,
  projectId: string,
  projectName: string
): Promise<void> {
  const groups = await prisma.projectGroupMember.findMany({ where: { projectId } })

  for (const group of groups) {
    try {
      await applyGroupToMember(member, {
        projectId,
        projectName,
        groupName: group.groupName,
        role: group.role,
      })
    } catch (err) {
      if (err instanceof HarborUnknownGroupError) continue
      await enqueue({
        registryId: member.registryId,
        kind: "GROUP_ADD",
        projectId,
        payload: { groupName: group.groupName },
      })
    }
  }
}
