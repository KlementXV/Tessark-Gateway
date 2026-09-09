import { withReplicationLock } from "./replication-lock"
import { retryAt } from "./replication-retry"
import { RegistryRole, type PendingOperation } from "@/generated/prisma/client"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "@/lib/registries/check"
import { isUsable } from "@/lib/registries/health"
import {
  deleteHarborArtifact,
  deleteHarborProject,
  deleteHarborRepository,
  deleteHarborRobotAccount,
} from "@/lib/registries/harbor"
import { adoptHarborProjects } from "./adopt"
import { parsePayload, errorMessage } from "./fanout"
import { MissingClusterIdentityError } from "./identity"
import { loadMember, type ClusterMember } from "./members"
import {
  applyMemberToMember,
  loadMemberDesiredState,
  removeMemberFromMember,
} from "./project-members"
import {
  applyGroupToMember,
  loadGroupDesiredState,
  removeGroupFromMember,
} from "./project-groups"
import { applyProjectToMember, markProjectPlacementFailed } from "./projects"
import { applyQuotaToMember } from "./quota"
import { applyRetentionToMember } from "./retention"
import { applyScanPolicyToMember } from "./scan-policy"
import {
  applyRobotToMember,
  loadRobotDesiredState,
  realignRobotSecrets,
  refreshRobotUnifiedFlag,
} from "./robots"
import { catchUpMember, syncClusterReplication } from "./replication"

// The other half of best-effort fan-out: whatever a member missed while it was down gets
// replayed here, the moment it answers a health probe again.

export interface ReconcileResult {
  registryId: string
  /** The member is still unreachable — nothing was attempted. */
  skipped: boolean
  replayed: number
  remaining: number
  /** Robots whose member-specific secret was brought back onto the cluster-wide one. */
  realigned: number
  error?: string
}

// A replay either succeeds, or is dropped because the thing it referred to no longer exists.
type ReplayOutcome = "done" | "stale"

async function replay(member: ClusterMember, op: PendingOperation): Promise<ReplayOutcome> {
  switch (op.kind) {
    case "PROJECT_CREATE": {
      const project = op.projectId
        ? await prisma.project.findUnique({ where: { id: op.projectId } })
        : null
      if (!project) return "stale"
      await applyProjectToMember(member, {
        id: project.id,
        name: project.name,
        isPublic: project.isPublic,
        storageQuotaMib: project.storageQuotaMib,
        autoScan: project.autoScan,
        autoSbom: project.autoSbom,
      })
      return "done"
    }

    case "PROJECT_DELETE": {
      // The Gateway row is long gone by now, so the target is carried in the payload.
      const harborProjectId = parsePayload(op.payload).harborProjectId
      if (typeof harborProjectId !== "number") return "stale"
      await deleteHarborProject(member.conn, harborProjectId)
      return "done"
    }

    case "ARTIFACT_DELETE": {
      // Everything the replay needs is in the payload, project name included: this member was
      // down when an image was removed, and the Gateway row for that project may well have gone
      // since. What has to happen on this Harbor does not depend on either.
      const payload = parsePayload(op.payload)
      const { projectName, repo, reference } = payload
      if (typeof projectName !== "string" || typeof repo !== "string") return "stale"
      if (typeof reference === "string") {
        await deleteHarborArtifact(member.conn, projectName, repo, reference)
      } else {
        await deleteHarborRepository(member.conn, projectName, repo)
      }
      return "done"
    }

    case "QUOTA_UPDATE": {
      const project = op.projectId
        ? await prisma.project.findUnique({ where: { id: op.projectId } })
        : null
      if (!project) return "stale"
      await applyQuotaToMember(member, project.id, project.storageQuotaMib)
      return "done"
    }

    case "SCAN_POLICY_UPDATE": {
      const project = op.projectId
        ? await prisma.project.findUnique({ where: { id: op.projectId } })
        : null
      if (!project) return "stale"
      await applyScanPolicyToMember(member, project.id, {
        autoScan: project.autoScan,
        autoSbom: project.autoSbom,
      })
      return "done"
    }

    case "RETENTION_UPSERT": {
      const policy = op.projectId
        ? await prisma.retentionPolicy.findUnique({ where: { projectId: op.projectId } })
        : null
      if (!policy) return "stale"
      await applyRetentionToMember(member, policy.projectId, {
        keepLastN: policy.keepLastN,
        tagPattern: policy.tagPattern,
      })
      return "done"
    }

    case "ROBOT_CREATE": {
      const loaded = op.robotAccountId ? await loadRobotDesiredState(op.robotAccountId) : null
      if (!loaded) return "stale"
      await applyRobotToMember(member, loaded.desired)
      // The replay may have brought the last stragglers in line — or landed a member that
      // still refuses the secret. Either way the flag is re-derived from the placements.
      await refreshRobotUnifiedFlag(loaded.desired.id)
      return "done"
    }

    case "ROBOT_DELETE": {
      const harborRobotId = parsePayload(op.payload).harborRobotId
      if (typeof harborRobotId !== "number") return "stale"
      await deleteHarborRobotAccount(member.conn, harborRobotId)
      return "done"
    }

    case "MEMBER_ADD": {
      const userId = parsePayload(op.payload).userId
      if (!op.projectId || typeof userId !== "string") return "stale"

      let loaded
      try {
        loaded = await loadMemberDesiredState(op.projectId, userId)
      } catch (err) {
        // The cluster now keeps its own directory and this person has no account mapped in
        // it. Retrying would fail identically every pass, and the entry would block every
        // later operation for this member (the drain stops at the first failure) — so it is
        // dropped with a trace, exactly as an account Harbor does not know is.
        if (err instanceof MissingClusterIdentityError) {
          logger.warn("Dropping a membership replay with no mapped cluster identity", {
            registryId: member.registryId,
            projectId: op.projectId,
            userId,
          })
          return "stale"
        }
        throw err
      }
      // The membership was revoked while this member was away — nothing left to grant.
      if (!loaded) return "stale"
      await applyMemberToMember(member, loaded.desired)
      return "done"
    }

    case "GROUP_ADD": {
      const groupName = parsePayload(op.payload).groupName
      if (!op.projectId || typeof groupName !== "string") return "stale"
      const loaded = await loadGroupDesiredState(op.projectId, groupName)
      // The grant was revoked while this member was away — nothing left to push.
      if (!loaded) return "stale"
      await applyGroupToMember(member, loaded.desired)
      return "done"
    }

    case "GROUP_REMOVE": {
      // The ProjectGroupMember row is long gone by now, so the target is carried in the payload.
      const payload = parsePayload(op.payload)
      const groupName = payload.groupName
      if (!op.projectId || typeof groupName !== "string") return "stale"

      const project = await prisma.project.findUnique({
        where: { id: op.projectId },
        select: { name: true },
      })
      const projectName = project?.name ?? payload.projectName
      if (typeof projectName !== "string") return "stale"

      await removeGroupFromMember(member, op.projectId, projectName, groupName)
      return "done"
    }

    case "MEMBER_REMOVE": {
      // The ProjectMember row is long gone by now, so the target is carried in the payload.
      const payload = parsePayload(op.payload)
      const username = payload.username
      if (!op.projectId || typeof username !== "string") return "stale"

      const project = await prisma.project.findUnique({
        where: { id: op.projectId },
        select: { name: true },
      })
      const projectName = project?.name ?? payload.projectName
      if (typeof projectName !== "string") return "stale"

      await removeMemberFromMember(member, op.projectId, projectName, username)
      return "done"
    }

    case "REPLICATION_SYNC": {
      const registry = await prisma.registry.findUnique({ where: { id: op.registryId } })
      if (!registry?.clusterId) return "stale"
      // Forced: this entry only exists because an edge failed to come up, so the fingerprint
      // recorded for it — if any — describes a state Harbor never actually reached.
      const result = await syncClusterReplication(registry.clusterId, { force: true })
      if (result.failed > 0) throw new Error(`${result.failed} replication links still failing`)
      return "done"
    }

    default:
      return "stale"
  }
}

// Drains one member's queue oldest-first, stopping at the first entry that still fails:
// later entries routinely depend on earlier ones (a robot needs its project), so pushing
// past a failure would just manufacture more failures.
export async function reconcileRegistry(registryId: string, respectBackoff = false): Promise<ReconcileResult> {
  return withReplicationLock(() => runReconcileRegistry(registryId, respectBackoff))
}

async function runReconcileRegistry(registryId: string, respectBackoff: boolean): Promise<ReconcileResult> {
  const member = await loadMember(registryId)
  if (!member) return { registryId, skipped: true, replayed: 0, remaining: 0, realigned: 0 }
  // Nothing is ever owed to a delivery registry — enqueue() refuses to write one — so there
  // is nothing to drain and no robot of ours to realign. Returning rather than throwing keeps
  // "reconcile everything" callers from having to filter first.
  if (member.role !== RegistryRole.MANAGED) {
    return { registryId, skipped: true, replayed: 0, remaining: 0, realigned: 0 }
  }

  const pendingCount = await prisma.pendingOperation.count({ where: { registryId } })
  // Robots this member holds under a secret of its own are reconciled here too, and that
  // can be the only work outstanding — so an empty queue is not on its own a reason to stop.
  const divergentCount = await prisma.robotPlacement.count({
    where: { registryId, encryptedSecret: { not: null }, harborRobotId: { not: null } },
  })
  if (pendingCount === 0 && divergentCount === 0) {
    return { registryId, skipped: false, replayed: 0, remaining: 0, realigned: 0 }
  }

  const health = await checkRegistryHealth(member.conn)
  if (!isUsable(health)) {
    return {
      registryId,
      skipped: true,
      replayed: 0,
      remaining: pendingCount,
      realigned: 0,
      error: health.error,
    }
  }

  const operations = await prisma.pendingOperation.findMany({
    where: { registryId },
    orderBy: { createdAt: "asc" },
  })

  let replayed = 0
  let blocked: string | undefined

  for (const op of operations) {
    if (respectBackoff && op.lastAttemptAt && retryAt(Math.max(0, op.attempts - 1), op.lastAttemptAt.getTime()).getTime() > Date.now()) break
    try {
      await replay(member, op)
      await prisma.pendingOperation.delete({ where: { id: op.id } })
      replayed += 1
    } catch (err) {
      blocked = errorMessage(err)
      logger.warn("Cluster reconcile blocked on a replay", {
        registryId,
        opKind: op.kind,
        attempts: op.attempts + 1,
        error: blocked,
      })
      await prisma.pendingOperation.update({
        where: { id: op.id },
        data: { attempts: { increment: 1 }, lastError: blocked, lastAttemptAt: new Date() },
      })
      if (op.projectId && op.kind === "PROJECT_CREATE") {
        await markProjectPlacementFailed(op.projectId, registryId, blocked)
      }
      break
    }
  }

  const remaining = await prisma.pendingOperation.count({ where: { registryId } })

  // After the queue, because a replay is what creates the placements this reads. Failures
  // are absorbed: a Harbor that refuses again simply stays divergent until the next pass.
  const realigned = await realignRobotSecrets(member).catch(() => 0)

  // Event-based policies only fire on new pushes, so a member that was away has to be told
  // to pull in what it missed.
  if (replayed > 0 && remaining === 0) {
    await catchUpMember(registryId)
  }

  return { registryId, skipped: false, replayed, remaining, realigned, error: blocked }
}

export async function reconcileCluster(clusterId: string): Promise<ReconcileResult[]> {
  return withReplicationLock(async () => {
    const registries = await prisma.registry.findMany({
      where: { clusterId }, select: { id: true }, orderBy: { name: "asc" },
    })
    const results: ReconcileResult[] = []
    for (const registry of registries) results.push(await reconcileRegistry(registry.id))
    return results
  })
}

// Opportunistic entry point for pages that already poll registry health (the registries and
// dashboard views). The persistent worker also drains these queues without page traffic;
// POST /api/clusters/[id]/reconcile forces a pass on demand.
export function reconcileRegistriesInBackground(registryIds: string[]): void {
  // Nothing awaits this, so nothing would catch it either: an escaping rejection is an
  // unhandled one, and Node ends the process on those. The whole body is guarded rather than
  // each call — a read of our own database can fail just as a Harbor can, and a page that
  // merely displayed registry health must never be able to take the pod down.
  void (async () => {
    try {
      await Promise.all(
        registryIds.map((id) =>
          reconcileRegistry(id).catch(() => {
            // Nothing to surface here — the queue rows keep the failure and the next pass retries.
          })
        )
      )

      // Same opportunism for adoption: with no scheduler around, a Harbor project the Gateway
      // has never seen is claimed on the next health read of its cluster.
      const registries = await prisma.registry.findMany({
        where: { id: { in: registryIds }, clusterId: { not: null } },
        select: { clusterId: true },
      })
      const clusterIds = [...new Set(registries.map((registry) => registry.clusterId!))]
      await Promise.all(clusterIds.map((id) => adoptHarborProjects(id).catch(() => {})))
    } catch (err) {
      logger.warn("Background reconcile pass failed", { error: errorMessage(err) })
    }
  })()
}
