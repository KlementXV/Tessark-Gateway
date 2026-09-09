// Taking a project down, from either of the two doors that lead here: a manager deleting it
// outright (DELETE /api/projects/[id]) and an admin approving somebody's request for the same
// thing (POST /api/project-delete-requests/[id]/approve).
//
// One implementation on purpose. An approval is a decision about *whether*, never about how:
// a reviewer who agreed with a request must not thereby skip the checks a manager would have
// hit — a project still holding repositories is refused to both, because Harbor refuses it, and
// a mirror pointing here is refused to both, because deleting the row would leave a Harbor
// policy or a CronJob running with nothing left in the Gateway to show it or stop it.

import { deleteProjectAcrossCluster, findNonEmptyMembers, forgetProject } from "@/lib/clusters/projects"
import { mirrorBlockMessage, mirrorsBlockingDelete } from "@/lib/mirrors/references"
import { blockProjectBuilds, withBuildLock } from "@/lib/builds/service"
import { prisma } from "@/lib/prisma"

export class ProjectDeleteError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = "ProjectDeleteError"
  }
}

export interface ProjectDeleteResult {
  deleted: number
  /** Members that were unreachable; their delete was queued for the reconciler. */
  queued: number
  failures: Array<{ registry: string; error: string }>
}

async function deleteProjectEverywhereInner(projectId: string): Promise<ProjectDeleteResult> {
  // Deleting a project deletes it on the Harbors too, images included — so a project that
  // still holds repositories is refused outright rather than half-deleted. Asking every member
  // up front is what keeps the fan-out below from tearing the project down on some Harbors and
  // stopping at the first one that says no.
  try { await blockProjectBuilds(projectId) } catch (err) { throw new ProjectDeleteError(err instanceof Error ? err.message : "Builds reference this project", 409) }
  let nonEmpty
  try {
    nonEmpty = await findNonEmptyMembers(projectId)
  } catch (err) {
    throw new ProjectDeleteError(
      err instanceof Error ? err.message : "Failed to inspect the project's Harbors",
      502,
    )
  }

  if (nonEmpty.length > 0) {
    const detail = nonEmpty.map((member) => `${member.registryName} (${member.repoCount})`).join(", ")
    throw new ProjectDeleteError(
      `This project still holds repositories on ${detail}. Delete them first — Harbor will not remove a project that isn't empty.`,
      409,
    )
  }

  // A mirror pointing here owns a Harbor policy or a CronJob that only DELETE /api/mirrors/[id]
  // takes down. The schema refuses the delete anyway (ScheduledMirror.project is Restrict);
  // this is the same refusal with the names in it.
  const blocking = await mirrorsBlockingDelete({ projectId })
  if (blocking.length > 0) {
    throw new ProjectDeleteError(mirrorBlockMessage("project", blocking), 409)
  }

  let summary
  try {
    summary = await deleteProjectAcrossCluster(projectId)
  } catch (err) {
    throw new ProjectDeleteError(
      err instanceof Error ? err.message : "Failed to delete the project",
      502,
    )
  }

  // Queued work is dropped before the row: PendingOperation.projectId is not a foreign key,
  // so a leftover PROJECT_CREATE could otherwise recreate a project that no longer exists.
  // The PROJECT_DELETE entries just queued carry no projectId, precisely so they survive it.
  await forgetProject(projectId)
  await prisma.project.delete({ where: { id: projectId } })

  return summary
}

export async function deleteProjectEverywhere(projectId: string) {
  return withBuildLock(() => deleteProjectEverywhereInner(projectId))
}
