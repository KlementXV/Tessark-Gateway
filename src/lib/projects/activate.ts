// Turning a project row into a live project: push it onto every Harbor of its cluster,
// flip it to ACTIVE, and seat its administrators.
//
// Two callers share this, and they must stay identical in effect — an admin creating a
// project straight away (POST /api/projects) and an admin approving somebody's request
// (POST /api/projects/[id]/approve) have to produce the same Harbor state, otherwise
// "created directly" would quietly mean "created differently".
import { MissingClusterIdentityError } from "@/lib/clusters/identity"
import { syncMemberAcrossCluster } from "@/lib/clusters/project-members"
import { syncProjectAcrossCluster } from "@/lib/clusters/projects"
import { prisma } from "@/lib/prisma"
import type { Project } from "@/generated/prisma/client"

export class ProjectActivationError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface ActivationResult {
  project: Project
  placements: {
    succeeded: number
    failed: number
    failures: { registry: string; error: string }[]
  }
}

/**
 * Activates `projectId` on behalf of `actorUserId`.
 *
 * Leaves the project untouched and throws a ProjectActivationError when no Harbor in the
 * cluster accepted it — the row stays PENDING so the work is never lost and can be retried
 * (by the reconciler, or by approving it again).
 */
export async function activateProject(
  projectId: string,
  actorUserId: string,
): Promise<ActivationResult> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new ProjectActivationError("Not found", 404)

  let summary
  try {
    summary = await syncProjectAcrossCluster(projectId)
  } catch (err) {
    throw new ProjectActivationError(
      err instanceof Error ? err.message : "Failed to create the Harbor project",
      502,
    )
  }

  // A partial result still activates the project: the Harbors that answered are usable
  // straight away, and the rest are queued for replay as soon as they come back (see
  // src/lib/clusters/reconcile.ts). Only a clean sweep of failures is fatal.
  if (summary.succeeded === 0) {
    const detail = summary.outcomes.map((o) => `${o.member.registryName}: ${o.error}`).join("; ")
    throw new ProjectActivationError(
      `No Harbor in the cluster accepted the project — ${detail}`,
      502,
    )
  }

  const updated = await prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE" } })

  // The project starts with two admins: whoever asked for it, and whoever activated it —
  // one and the same when an admin creates it directly, hence the dedupe. Upserted rather
  // than created because either may already sit on the project: the requester can add
  // members while it is still pending.
  const projectAdmins = [...new Set([project.ownerUserId, actorUserId])].filter(
    (userId): userId is string => Boolean(userId),
  )
  await prisma.$transaction(
    projectAdmins.map((userId) =>
      prisma.projectMember.upsert({
        where: { projectId_userId: { projectId, userId } },
        create: { projectId, userId, role: "PROJECT_ADMIN" },
        update: { role: "PROJECT_ADMIN" },
      }),
    ),
  )

  // Those two rows are written after the project has landed, so the fan-out that carried the
  // project could not have carried them: without this the seats existed only in the Gateway
  // until somebody reconciled the cluster. A seat that cannot be pushed — an account the
  // cluster's directory does not know, or does not map — is reported and nothing more: the
  // project is live on the Harbors that accepted it, and refusing to activate over a single
  // grant would leave it stranded in PENDING (same rule as the partial placement above).
  const memberFailures: { registry: string; error: string }[] = []
  // Named for the failure list, which is rendered as "<where>: <what>". A resolution failure
  // belongs to the cluster as a whole, not to one of its Harbors.
  const cluster = await prisma.cluster.findUnique({
    where: { id: project.clusterId },
    select: { name: true },
  })
  for (const userId of projectAdmins) {
    try {
      const memberSummary = await syncMemberAcrossCluster(projectId, userId)
      memberFailures.push(...memberSummary.failures)
    } catch (err) {
      memberFailures.push({
        registry: cluster?.name ?? "cluster",
        error:
          err instanceof MissingClusterIdentityError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to seat the project administrator",
      })
    }
  }

  return {
    project: updated,
    placements: {
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: [
        ...summary.outcomes
          .filter((o) => !o.ok)
          .map((o) => ({ registry: o.member.registryName, error: o.error ?? "Unknown error" })),
        ...memberFailures,
      ],
    },
  }
}
