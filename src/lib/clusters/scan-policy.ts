import { prisma } from "@/lib/prisma"
import {
  getHarborVersion,
  harborSupportsSbom,
  setHarborProjectMetadata,
} from "@/lib/registries/harbor"
import { enqueue, fanOut, type MemberOutcome } from "./fanout"
import { loadClusterMembers, type ClusterMember } from "./members"

// Scan-on-push and SBOM-on-push are Harbor project metadata, so they are per-Harbor settings
// exactly like isPublic and the storage quota: the Gateway holds the desired state and pushes
// it to every member of the cluster. A member that was down when the switch was flipped
// converges on its next reconcile rather than being left quietly out of policy — which for a
// scanning policy is the whole point, since the unscanned member is the one that matters.

export interface ScanPolicy {
  autoScan: boolean
  autoSbom: boolean
}

/** Per-member outcome, carrying whether the SBOM half had to be dropped for age. */
export interface ScanPolicyApplied {
  /** False when this Harbor predates 2.12 and the SBOM key was left out of the request. */
  sbomApplied: boolean
}

/**
 * Pushes the policy to one member.
 *
 * `auto_sbom_generation` is omitted rather than sent as "false" on a Harbor older than 2.12:
 * those validate metadata keys against a whitelist and reject the entire PUT on an unknown
 * one, which would take `auto_scan` down with it. Losing the SBOM half on an old member is a
 * degradation; losing both because of it would be a bug.
 */
export async function applyScanPolicyToMember(
  member: ClusterMember,
  projectId: string,
  policy: ScanPolicy
): Promise<ScanPolicyApplied> {
  const placement = await prisma.projectPlacement.findUnique({
    where: { projectId_registryId: { projectId, registryId: member.registryId } },
    include: { project: { select: { name: true } } },
  })
  if (!placement?.harborProjectId) {
    throw new Error(`Project is not present on ${member.registryName} yet`)
  }

  const supportsSbom = harborSupportsSbom(await getHarborVersion(member.conn))

  await setHarborProjectMetadata(member.conn, placement.project.name, {
    autoScan: policy.autoScan,
    ...(supportsSbom ? { autoSbom: policy.autoSbom } : {}),
  })

  // Only a policy that actually wanted an SBOM can be said to have lost it.
  return { sbomApplied: supportsSbom || !policy.autoSbom }
}

export interface ScanPolicySyncSummary {
  succeeded: number
  failed: number
  /** Members that took the policy but could not take its SBOM half, by registry name. */
  sbomUnsupported: string[]
  outcomes: MemberOutcome<ScanPolicyApplied>[]
}

export async function syncScanPolicyAcrossCluster(
  projectId: string,
  policy: ScanPolicy
): Promise<ScanPolicySyncSummary> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const outcomes = await fanOut(members, (member) =>
    applyScanPolicyToMember(member, projectId, policy)
  )

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "SCAN_POLICY_UPDATE",
      projectId,
    })
  }

  return {
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    sbomUnsupported: outcomes
      .filter((o) => o.ok && o.value && !o.value.sbomApplied)
      .map((o) => o.member.registryName),
    outcomes,
  }
}
