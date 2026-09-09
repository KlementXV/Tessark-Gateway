import { ClusterIdentityMode } from "@/generated/prisma/client"
import { blockProjectBuilds, withBuildLock } from "@/lib/builds/service"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { enqueue } from "./fanout"
import { usersMissingIdentityAmong } from "./identity"
import { loadClusterMembers } from "./members"
import {
  deleteProjectAcrossCluster,
  findNonEmptyMembers,
  forgetProject,
  type ProjectDeleteSummary,
} from "./projects"
import { reconcileRegistry } from "./reconcile"

/**
 * Moving a project from one cluster to another.
 *
 * Until this existed, `Project.clusterId` was required and there was no way to change it, so
 * consolidating two clusters meant deleting projects and recreating them — which is how a
 * reorganisation silently took scheduled mirrors with it. This is the non-destructive path.
 *
 * "Non-destructive" is about the Gateway's own records — memberships, robots, retention,
 * quota, mirrors, transfer history all survive and follow the project. It is *not* a copy of
 * the images: the project is deleted on the old cluster's Harbors and recreated on the new
 * one's, which is why an occupied project is refused outright rather than half-moved.
 *
 * The rebuild reuses the queue the reconciler already drains rather than a second fan-out
 * path — exactly what addClusterMember() does for a joining Harbor, and for the same reason:
 * a target member that is down converges when it comes back instead of failing the move.
 */

export type MoveRefusal =
  | { code: "projectNotFound" }
  | { code: "clusterNotFound" }
  | { code: "sameCluster" }
  /** Another project already holds this name over there — Project is unique per cluster+name. */
  | { code: "nameTaken" }
  /** Harbor will not delete a project that still holds repositories, so neither will this. */
  | { code: "notEmpty"; members: Array<{ registryName: string; repoCount: number }> }
  /** The target keeps its own directory and these people have no account mapped in it. */
  | { code: "unmappedMembers"; users: Array<{ id: string; username: string }> }

export interface MoveSummary {
  /** What removing the project from the old cluster's Harbors did. */
  removed: ProjectDeleteSummary
  /** Members of the target cluster the rebuild was queued on. */
  targetMembers: number
  /** Mirrors whose transport object has to be reinstalled — see below. */
  mirrorsToReapply: Array<{ id: string; name: string }>
}

export type MoveResult = { ok: true; summary: MoveSummary } | { ok: false; refusal: MoveRefusal }

async function moveProjectToClusterInner(
  projectId: string,
  targetClusterId: string,
): Promise<MoveResult> {
  await blockProjectBuilds(projectId)
  const [project, target] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { select: { userId: true } },
        robotAccounts: { select: { id: true } },
        retentionPolicy: { select: { projectId: true } },
      },
    }),
    prisma.cluster.findUnique({ where: { id: targetClusterId } }),
  ])

  if (!project) return { ok: false, refusal: { code: "projectNotFound" } }
  if (!target) return { ok: false, refusal: { code: "clusterNotFound" } }
  if (project.clusterId === targetClusterId) return { ok: false, refusal: { code: "sameCluster" } }

  const collision = await prisma.project.findFirst({
    where: { clusterId: targetClusterId, name: project.name },
    select: { id: true },
  })
  if (collision) return { ok: false, refusal: { code: "nameTaken" } }

  // Asked before anything is written, for the same reason deleting a project asks: a refusal
  // discovered halfway through would leave the project gone on some Harbors and present on
  // others, with the Gateway pointing at the wrong cluster either way.
  const nonEmpty = await findNonEmptyMembers(projectId)
  if (nonEmpty.length > 0) return { ok: false, refusal: { code: "notEmpty", members: nonEmpty } }

  if (target.identityMode === ClusterIdentityMode.MAPPED) {
    const missing = await usersMissingIdentityAmong(
      targetClusterId,
      project.members.map((member) => member.userId),
    )
    if (missing.length > 0) {
      return {
        ok: false,
        refusal: {
          code: "unmappedMembers",
          users: missing.map((user) => ({ id: user.id, username: user.username })),
        },
      }
    }
  }

  // A mirror's destination follows the project, but its transport object does not: a Harbor
  // replication policy lives on one specific Harbor of the old cluster, and a CronJob pushes
  // to a project id that is about to be recreated elsewhere. Rather than reinstall them
  // silently — which would fail on an unreachable Harbor and lose the mirror's meaning — they
  // are marked not-applied and reported, so `POST /api/mirrors/[id]/apply` reinstalls them on
  // the operator's terms. The definitions survive; only the schedule pauses.
  const mirrors = await prisma.scheduledMirror.findMany({
    where: { projectId, applied: true },
    select: { id: true, name: true },
  })

  const removed = await deleteProjectAcrossCluster(projectId)

  // Drops queued work keyed on this project — a PROJECT_CREATE still owed to an old member
  // would otherwise recreate it there after the move. The PROJECT_DELETE entries just queued
  // survive: enqueue() deliberately stores them without a projectId, keyed on the Harbor-side
  // id in their payload, precisely so this call cannot cancel them.
  await forgetProject(projectId)

  const oldMembers = await loadClusterMembers(project.clusterId)
  const oldMemberIds = oldMembers.map((member) => member.registryId)
  await prisma.projectPlacement.deleteMany({
    where: { projectId, registryId: { in: oldMemberIds } },
  })
  await prisma.robotPlacement.deleteMany({
    where: {
      registryId: { in: oldMemberIds },
      robotAccount: { projectId },
    },
  })

  await prisma.project.update({ where: { id: projectId }, data: { clusterId: targetClusterId } })

  if (mirrors.length > 0) {
    await prisma.scheduledMirror.updateMany({
      where: { id: { in: mirrors.map((mirror) => mirror.id) } },
      data: {
        applied: false,
        lastError: "The destination project moved to another cluster — reinstall this mirror.",
      },
    })
  }

  // Same backlog addClusterMember() queues for a joining Harbor, and drained the same way.
  const targetMembers = await loadClusterMembers(targetClusterId)
  for (const member of targetMembers) {
    await enqueue({ registryId: member.registryId, kind: "PROJECT_CREATE", projectId })
    if (project.retentionPolicy) {
      await enqueue({ registryId: member.registryId, kind: "RETENTION_UPSERT", projectId })
    }
    for (const robot of project.robotAccounts) {
      await enqueue({
        registryId: member.registryId,
        kind: "ROBOT_CREATE",
        projectId,
        robotAccountId: robot.id,
      })
    }
  }
  for (const member of targetMembers) {
    await reconcileRegistry(member.registryId)
  }

  logger.info("Project moved between clusters", {
    projectId,
    from: project.clusterId,
    to: targetClusterId,
    targetMembers: targetMembers.length,
    mirrorsPaused: mirrors.length,
  })

  return {
    ok: true,
    summary: { removed, targetMembers: targetMembers.length, mirrorsToReapply: mirrors },
  }
}

export async function moveProjectToCluster(projectId: string, targetClusterId: string) {
  return withBuildLock(() => moveProjectToClusterInner(projectId, targetClusterId))
}
