import { prisma } from "@/lib/prisma"
import { createHarborRetentionPolicy, updateHarborRetentionPolicy } from "@/lib/registries/harbor"
import { enqueue, fanOut, type MemberOutcome } from "./fanout"
import { loadClusterMembers, type ClusterMember } from "./members"

export interface RetentionDesiredState {
  keepLastN: number
  tagPattern: string
}

// Retention is per Harbor project, so it needs that member's own project ID and its own
// policy ID — both live on the placement. A member whose project hasn't landed yet can't
// carry a policy, so it is queued instead of failed.
export async function applyRetentionToMember(
  member: ClusterMember,
  projectId: string,
  desired: RetentionDesiredState
): Promise<void> {
  const placement = await prisma.projectPlacement.findUnique({
    where: { projectId_registryId: { projectId, registryId: member.registryId } },
  })
  if (!placement?.harborProjectId) {
    throw new Error(`Project is not present on ${member.registryName} yet`)
  }

  if (placement.harborRetentionId) {
    await updateHarborRetentionPolicy(
      member.conn,
      placement.harborRetentionId,
      placement.harborProjectId,
      desired.keepLastN,
      desired.tagPattern
    )
    return
  }

  const harborRetentionId = await createHarborRetentionPolicy(
    member.conn,
    placement.harborProjectId,
    desired.keepLastN,
    desired.tagPattern
  )
  await prisma.projectPlacement.update({
    where: { id: placement.id },
    data: { harborRetentionId },
  })
}

export interface RetentionSyncSummary {
  succeeded: number
  failed: number
  outcomes: MemberOutcome<void>[]
}

export async function syncRetentionAcrossCluster(
  projectId: string,
  desired: RetentionDesiredState
): Promise<RetentionSyncSummary> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const outcomes = await fanOut(members, (member) =>
    applyRetentionToMember(member, projectId, desired)
  )

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "RETENTION_UPSERT",
      projectId,
    })
  }

  return {
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  }
}
