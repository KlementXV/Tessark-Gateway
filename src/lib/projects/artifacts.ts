// Removing what a project holds: one artifact, or a whole repository.
//
// Every other write in this app describes a *desired state* the reconciler converges towards.
// This one does not: images are pushed by clients that never touch the Gateway, so there is no
// desired list of artifacts to hold — only the one gesture "this must not be here any more".
//
// Which is why it is fanned out to every member rather than written once and left to
// replication. A cluster whose replicationMode is "none" or "scheduled" would keep the image
// alive on the peers; worse, an event-based mesh that carries the deletion in one direction
// still leaves the Gateway unable to say whether it landed. Deleting on each member is
// idempotent (Harbor answers 404 to the second attempt, which this reads as success), so the
// belt-and-braces costs nothing and removes the guessing.

import { prisma } from "@/lib/prisma"
import { deleteHarborArtifact, deleteHarborRepository } from "@/lib/registries/harbor"
import { enqueue, fanOut } from "@/lib/clusters/fanout"
import { toMember } from "@/lib/clusters/members"

export interface ArtifactDeleteSummary {
  /** Members the deletion actually reached. */
  deleted: number
  /** Members that were unreachable; their deletion was queued for the reconciler. */
  queued: number
  failures: Array<{ registry: string; error: string }>
}

/**
 * Deletes one artifact — or the whole repository when `reference` is null — from every Harbor
 * of the project's cluster.
 *
 * `reference` is a digest in every call the UI makes. Harbor's endpoint accepts a tag too, but
 * deleting by tag deletes the artifact behind it, tags and all: a caller who thought they were
 * removing `:1.26` would take `:1.26-alpine` and `:stable` with it. The digest names exactly
 * one object, and the UI lists the tags that go with it before asking.
 */
export async function deleteProjectArtifact(
  projectId: string,
  projectName: string,
  repo: string,
  reference: string | null,
): Promise<ArtifactDeleteSummary> {
  // Only the members that actually carry the project. A placement that never succeeded holds
  // nothing to delete, and asking would only produce a 404 to explain away.
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, harborProjectId: { not: null } },
    include: { registry: true },
  })

  const outcomes = await fanOut(
    placements.map((placement) => toMember(placement.registry)),
    async (member) => {
      if (reference) await deleteHarborArtifact(member.conn, projectName, repo, reference)
      else await deleteHarborRepository(member.conn, projectName, repo)
    },
  )

  let queued = 0
  const failures: Array<{ registry: string; error: string }> = []

  for (const outcome of outcomes) {
    if (outcome.ok) continue
    failures.push({ registry: outcome.member.registryName, error: outcome.error ?? "Unknown error" })
    // Queued rather than reported and forgotten: an image left on one member of a mesh comes
    // back to the others on the next replication pass, so "deleted on two of three Harbors" is
    // not a state that survives — it is a deletion that quietly undoes itself.
    await enqueue({
      registryId: outcome.member.registryId,
      kind: "ARTIFACT_DELETE",
      projectId,
      payload: { projectName, repo, reference },
    })
    queued += 1
  }

  return { deleted: outcomes.filter((outcome) => outcome.ok).length, queued, failures }
}
