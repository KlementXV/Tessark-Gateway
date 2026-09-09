import { prisma } from "@/lib/prisma"
import {
  getHarborProjectQuota,
  HarborQuotaRejectedError,
  setHarborProjectQuota,
} from "@/lib/registries/harbor"
import { enqueue, fanOut, type MemberOutcome } from "./fanout"
import { loadClusterMembers, type ClusterMember } from "./members"

export const MIB = 1024 * 1024

/** Harbor's sentinel for an unlimited quota. */
export const HARBOR_NO_LIMIT = -1

export function mibToHarborBytes(storageQuotaMib: number | null): number {
  return storageQuotaMib === null ? HARBOR_NO_LIMIT : storageQuotaMib * MIB
}

// The quota lives on the member's own Harbor project, so — like retention — it needs that
// member's numeric project ID off the placement. Harbor materialises a quota object with the
// project and never lets it be deleted, so this only ever updates: the ID is read from the
// placement when it has been seen before, and looked up by reference otherwise.
export async function applyQuotaToMember(
  member: ClusterMember,
  projectId: string,
  storageQuotaMib: number | null
): Promise<void> {
  const placement = await prisma.projectPlacement.findUnique({
    where: { projectId_registryId: { projectId, registryId: member.registryId } },
  })
  if (!placement?.harborProjectId) {
    throw new Error(`Project is not present on ${member.registryName} yet`)
  }

  let quotaId = placement.harborQuotaId
  if (!quotaId) {
    const quota = await getHarborProjectQuota(member.conn, placement.harborProjectId)
    if (!quota) {
      // Nothing to write to. Lifting a limit that cannot exist is already the desired state,
      // so only an actual limit is worth failing over.
      if (storageQuotaMib === null) return
      throw new Error(`${member.registryName} does not expose a storage quota for this project`)
    }
    quotaId = quota.id
    await prisma.projectPlacement.update({
      where: { id: placement.id },
      data: { harborQuotaId: quotaId },
    })
  }

  await setHarborProjectQuota(member.conn, quotaId, mibToHarborBytes(storageQuotaMib))
}

export interface QuotaSyncSummary {
  succeeded: number
  failed: number
  outcomes: MemberOutcome<void>[]
}

export async function syncQuotaAcrossCluster(
  projectId: string,
  storageQuotaMib: number | null
): Promise<QuotaSyncSummary> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const outcomes = await fanOut(members, (member) =>
    applyQuotaToMember(member, projectId, storageQuotaMib)
  )

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    // A member that refused the value on merit is not queued: replaying it would fail
    // identically forever and, since a member's queue stops at its first failure, would wall
    // off every later operation owed to that Harbor.
    if (outcome.reason instanceof HarborQuotaRejectedError) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "QUOTA_UPDATE",
      projectId,
    })
  }

  return {
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  }
}

export interface MemberQuotaUsage {
  registryId: string
  registryName: string
  /** -1 when that Harbor holds no limit; null when the figure could not be read. */
  hardBytes: number | null
  usedBytes: number | null
  error: string | null
}

// Live read, straight from each Harbor: the Gateway records the desired limit but never the
// consumption, and stale consumption is worse than none when the whole point is deciding
// whether a quota is too tight.
export async function readQuotaUsageAcrossCluster(projectId: string): Promise<MemberQuotaUsage[]> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const placements = await prisma.projectPlacement.findMany({ where: { projectId } })
  const byRegistry = new Map(placements.map((placement) => [placement.registryId, placement]))

  const outcomes = await fanOut(members, async (member) => {
    const harborProjectId = byRegistry.get(member.registryId)?.harborProjectId
    if (!harborProjectId) throw new Error("Project not present on this Harbor yet")
    return getHarborProjectQuota(member.conn, harborProjectId)
  })

  return outcomes.map((outcome) => ({
    registryId: outcome.member.registryId,
    registryName: outcome.member.registryName,
    hardBytes: outcome.ok ? (outcome.value?.hardBytes ?? null) : null,
    usedBytes: outcome.ok ? (outcome.value?.usedBytes ?? null) : null,
    error: outcome.ok ? null : (outcome.error ?? "Unknown error"),
  }))
}
