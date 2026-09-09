import { prisma } from "@/lib/prisma"
import {
  createHarborProject,
  deleteHarborProject,
  findHarborProjectIdByName,
  getHarborProjectRepoCount,
  HarborProjectNotEmptyError,
} from "@/lib/registries/harbor"
import { enqueue, errorMessage, fanOut, type MemberOutcome } from "./fanout"
import { assertManaged, loadClusterMembers, toMember, type ClusterMember } from "./members"
import { applyProjectGroupsToMember } from "./project-groups"
import { applyProjectMembersToMember } from "./project-members"
import { applyQuotaToMember, mibToHarborBytes } from "./quota"
import { applyScanPolicyToMember } from "./scan-policy"

// Every one of these is written to be safely repeatable: the reconciler replays the same
// call after a member comes back, and an approval retried by an admin must not double up.

export interface ProjectRef {
  id: string
  name: string
  isPublic: boolean
  /** MiB, or null for unlimited — see Project.storageQuotaMib. */
  storageQuotaMib?: number | null
  /** Harbor `auto_scan` / `auto_sbom_generation` — see Project.autoScan. */
  autoScan?: boolean
  autoSbom?: boolean
}

// Adopts the project if a previous attempt already created it on this Harbor, otherwise
// creates it. Either way the placement ends up ACTIVE with the member's own numeric ID.
export async function applyProjectToMember(
  member: ClusterMember,
  project: ProjectRef
): Promise<number> {
  // Creating a project is the most consequential write the fan-out does, so it is asserted
  // here as well as filtered upstream: a DELIVERY Harbor's project list belongs to its own
  // team, and adding to it would be the Gateway administering a registry it does not own.
  assertManaged(member)

  const existing = await findHarborProjectIdByName(member.conn, project.name)
  const quotaMib = project.storageQuotaMib ?? null
  const harborProjectId =
    existing ??
    (await createHarborProject(member.conn, project.name, {
      public: project.isPublic,
      storageLimitBytes: mibToHarborBytes(quotaMib),
      autoScan: project.autoScan,
      autoSbom: project.autoSbom,
    }))

  await prisma.projectPlacement.upsert({
    where: {
      projectId_registryId: { projectId: project.id, registryId: member.registryId },
    },
    create: {
      projectId: project.id,
      registryId: member.registryId,
      harborProjectId,
      status: "ACTIVE",
      syncedAt: new Date(),
    },
    update: {
      harborProjectId,
      status: "ACTIVE",
      lastError: null,
      syncedAt: new Date(),
    },
  })

  // A project that already existed on this Harbor kept whatever limit it was carrying, so
  // the desired quota has to be pushed on top of it — a freshly created one took it in the
  // create call above. Failing here would mark the placement FAILED for a project that is
  // in fact present, so the quota is queued on its own instead.
  if (existing) {
    try {
      await applyQuotaToMember(member, project.id, quotaMib)
    } catch {
      await enqueue({ registryId: member.registryId, kind: "QUOTA_UPDATE", projectId: project.id })
    }
    // Same reasoning for the scan policy: a pre-existing project on this Harbor kept whatever
    // flags it had, and an unscanned member is exactly the gap this setting exists to close.
    try {
      await applyScanPolicyToMember(member, project.id, {
        autoScan: project.autoScan ?? false,
        autoSbom: project.autoSbom ?? false,
      })
    } catch {
      await enqueue({
        registryId: member.registryId,
        kind: "SCAN_POLICY_UPDATE",
        projectId: project.id,
      })
    }
  }

  // The project alone grants nobody anything: without this, a member that was down through a
  // membership change comes back holding the project and none of its access. Failures inside
  // are queued per user, so they never mark this placement FAILED for a project that is there.
  await applyProjectMembersToMember(member, project.id, project.name)
  await applyProjectGroupsToMember(member, project.id, project.name)

  return harborProjectId
}

export async function markProjectPlacementFailed(
  projectId: string,
  registryId: string,
  error: string
): Promise<void> {
  await prisma.projectPlacement.upsert({
    where: { projectId_registryId: { projectId, registryId } },
    create: { projectId, registryId, status: "FAILED", lastError: error },
    update: { status: "FAILED", lastError: error },
  })
}

export interface ProjectSyncSummary {
  succeeded: number
  failed: number
  outcomes: MemberOutcome<number>[]
}

// Creates the project on every member of its cluster. Members that fail are recorded as
// FAILED placements and queued for replay, so the caller can still mark the project ACTIVE
// as long as at least one member took it.
export async function syncProjectAcrossCluster(projectId: string): Promise<ProjectSyncSummary> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const members = await loadClusterMembers(project.clusterId)
  const outcomes = await fanOut(members, (member) =>
    applyProjectToMember(member, {
      id: project.id,
      name: project.name,
      isPublic: project.isPublic,
      storageQuotaMib: project.storageQuotaMib,
      autoScan: project.autoScan,
      autoSbom: project.autoSbom,
    })
  )

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    await markProjectPlacementFailed(
      project.id,
      outcome.member.registryId,
      outcome.error ?? "Unknown error"
    )
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "PROJECT_CREATE",
      projectId: project.id,
    })
  }

  return {
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  }
}

// Drops the Gateway's own bookkeeping for a project, including queued work that would
// otherwise recreate it on a member that comes back later.
export async function forgetProject(projectId: string): Promise<void> {
  await prisma.pendingOperation.deleteMany({ where: { projectId } })
}

export interface NonEmptyMember {
  registryName: string
  repoCount: number
}

// Harbor refuses to delete a project that still holds repositories, so every member is asked
// first: a refusal discovered halfway through the fan-out would leave the project deleted on
// some Harbors and alive on the others, with the Gateway row gone either way. Members that
// can't be reached are not an obstacle — their delete is queued below.
export async function findNonEmptyMembers(projectId: string): Promise<NonEmptyMember[]> {
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, harborProjectId: { not: null } },
    include: { registry: true },
  })

  const outcomes = await fanOut(
    placements.map((placement) => toMember(placement.registry)),
    async (member) => {
      const harborProjectId = placements.find((p) => p.registryId === member.registryId)!
        .harborProjectId!
      return getHarborProjectRepoCount(member.conn, harborProjectId)
    }
  )

  return outcomes
    .filter((outcome) => outcome.ok && (outcome.value ?? 0) > 0)
    .map((outcome) => ({ registryName: outcome.member.registryName, repoCount: outcome.value! }))
}

export interface ProjectDeleteSummary {
  deleted: number
  /** Members that were unreachable; their delete was queued for the reconciler. */
  queued: number
  failures: Array<{ registry: string; error: string }>
}

// Deletes the project on every member that carries it. Same best-effort contract as the rest
// of the fan-out: a member that is down has its delete parked in PendingOperation, keyed on
// the Harbor-side ID since the Gateway row is about to disappear.
export async function deleteProjectAcrossCluster(projectId: string): Promise<ProjectDeleteSummary> {
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, harborProjectId: { not: null } },
    include: { registry: true },
  })

  const outcomes = await fanOut(
    placements.map((placement) => toMember(placement.registry)),
    async (member) => {
      const harborProjectId = placements.find((p) => p.registryId === member.registryId)!
        .harborProjectId!
      await deleteHarborProject(member.conn, harborProjectId)
    }
  )

  let queued = 0
  const failures: Array<{ registry: string; error: string }> = []

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    failures.push({ registry: outcome.member.registryName, error: outcome.error ?? "Unknown error" })

    // A project that filled up between the pre-flight and here will refuse just as firmly on
    // every replay, so it is reported rather than queued — an admin has to empty it and
    // delete it on that Harbor themselves.
    if (outcome.reason instanceof HarborProjectNotEmptyError) continue

    const harborProjectId = placements.find((p) => p.registryId === outcome.member.registryId)!
      .harborProjectId!
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "PROJECT_DELETE",
      projectId,
      payload: { harborProjectId },
    })
    queued += 1
  }

  return { deleted: outcomes.filter((o) => o.ok).length, queued, failures }
}

export { errorMessage }
