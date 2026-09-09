import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "@/lib/registries/check"
import { isUsable } from "@/lib/registries/health"
import {
  getHarborProjectQuota,
  listHarborProjects,
  type HarborProject,
} from "@/lib/registries/harbor"
import { loadClusterMembers, type ClusterMember } from "./members"
import { MIB } from "./quota"

// A Harbor never starts empty: it ships with the public `library` project, and a Harbor that
// existed before the Gateway did carries whatever its admins created by hand. None of that
// has a Project row here, so none of it shows up in the UI — adoption closes that gap by
// writing the rows the Gateway would have written had it created them itself.
//
// Adopted projects are ACTIVE with a null ownerUserId: they were never requested, so there is
// no requester to make a manager. Visibility comes from Harbor's own metadata.public, which
// is what makes `library` land in everyone's Projects list.

export interface AdoptionResult {
  /** Names newly written to the database. */
  adopted: string[]
  /** Members that could not be read — their projects may still be missing. */
  unreachable: string[]
}

interface Sighting {
  member: ClusterMember
  project: HarborProject
}

/**
 * What joining this cluster would do to a Harbor's existing content.
 *
 * Membership is not a bookkeeping change: it arms a full replication mesh whose policies carry
 * `filters: ["**"]`, `override: true` and `deletion: true`. Everything the candidate holds is
 * pushed to every peer, and a project whose name already exists over there is *overwritten*,
 * not merged. Both consequences are worth naming before the click rather than discovering
 * afterwards, and they are not the same consequence:
 *
 *   * `incoming` — projects only the candidate has. They will be adopted and spread to the
 *     peers. Legitimate, and often the point, but it should be a decision.
 *   * `colliding` — a name the cluster already carries. The two Harbors hold different content
 *     under one name and the mesh has no way to know which is right, so one silently wins.
 *     Refused outright; renaming or emptying is the operator's call, not ours to guess.
 *
 * A collision is only possible once the cluster has another member: with none, there is
 * nothing on the far side to overwrite and the "collision" is simply adoption.
 */
export interface JoinInspection {
  colliding: string[]
  incoming: string[]
  /** Why the candidate could not be listed — never to be read as "it holds nothing". */
  error: string | null
}

export async function inspectJoinCandidate(
  clusterId: string,
  candidate: ClusterMember
): Promise<JoinInspection> {
  const health = await checkRegistryHealth(candidate.conn)
  if (!isUsable(health)) {
    return { colliding: [], incoming: [], error: health.error ?? "This Harbor is unreachable" }
  }

  let projects: HarborProject[]
  try {
    projects = await listHarborProjects(candidate.conn)
  } catch (err) {
    return {
      colliding: [],
      incoming: [],
      error: err instanceof Error ? err.message : "This Harbor's projects could not be listed",
    }
  }

  const names = projects.map((project) => project.name)
  const known = await prisma.project.findMany({
    where: { clusterId, name: { in: names } },
    select: { name: true },
  })
  const knownNames = new Set(known.map((project) => project.name))
  const existingMembers = await loadClusterMembers(clusterId)

  return {
    colliding: existingMembers.length > 0 ? names.filter((name) => knownNames.has(name)) : [],
    incoming: names.filter((name) => !knownNames.has(name)),
    error: null,
  }
}

export async function adoptHarborProjects(clusterId: string): Promise<AdoptionResult> {
  const members = await loadClusterMembers(clusterId)

  // Name → where it was seen. A cluster is a mesh of Harbors holding the same projects, so
  // one logical project is normally sighted once per member, and each sighting carries that
  // member's own numeric ID for the placement row.
  const sightings = new Map<string, Sighting[]>()
  const unreachable: string[] = []

  for (const member of members) {
    const health = await checkRegistryHealth(member.conn)
    if (!isUsable(health)) {
      unreachable.push(member.registryName)
      continue
    }

    let projects: HarborProject[]
    try {
      projects = await listHarborProjects(member.conn)
    } catch {
      unreachable.push(member.registryName)
      continue
    }

    for (const project of projects) {
      const seen = sightings.get(project.name) ?? []
      seen.push({ member, project })
      sightings.set(project.name, seen)
    }
  }

  if (sightings.size === 0) return { adopted: [], unreachable }

  const known = await prisma.project.findMany({
    where: { clusterId, name: { in: [...sightings.keys()] } },
    select: { name: true },
  })
  const knownNames = new Set(known.map((project) => project.name))

  const adopted: string[] = []
  for (const [name, seen] of sightings) {
    if (knownNames.has(name)) continue

    // Public on any member is public, full stop — the image is readable from the mesh either
    // way, so the stricter reading would misrepresent who can reach it.
    const isPublic = seen.some((sighting) => sighting.project.isPublic)

    // Read in, never imposed. The Gateway default is false, and writing that over a project
    // whose team had switched scanning on would silently disarm it. `some` for the same
    // reason as isPublic: if any member scans on push, that is the behaviour in force.
    const autoScan = seen.some((sighting) => sighting.project.autoScan)
    const autoSbom = seen.some((sighting) => sighting.project.autoSbom)

    try {
      await createAdopted(clusterId, name, isPublic, { autoScan, autoSbom }, seen)
    } catch (err) {
      // Two reconciles racing on the same cluster: the loser hits the [clusterId, name]
      // unique constraint, which means the row it wanted now exists. Nothing to repair.
      if (err instanceof Error && err.message.includes("Unique constraint")) continue
      throw err
    }
    adopted.push(name)
  }

  return { adopted, unreachable }
}

// The quota a project already carries on its Harbors is read in rather than assumed away:
// leaving storageQuotaMib null would tell the UI "unlimited" about a project that is in fact
// capped, and the first save from the Quota tab would then lift a limit nobody meant to
// touch. A member that won't answer contributes nothing — its own limit is discovered on the
// next save or usage read.
async function readAdoptedQuota(seen: Sighting[]) {
  const quotas = await Promise.all(
    seen.map(async (sighting) => {
      try {
        return await getHarborProjectQuota(sighting.member.conn, sighting.project.projectId)
      } catch {
        return null
      }
    })
  )

  // Members can disagree; the tightest limit is the one that actually binds what can be
  // pushed to the mesh, so it becomes the desired state everywhere.
  const limits = quotas.map((quota) => quota?.hardBytes ?? -1).filter((bytes) => bytes > 0)
  const hardBytes = limits.length > 0 ? Math.min(...limits) : null

  return {
    storageQuotaMib: hardBytes === null ? null : Math.ceil(hardBytes / MIB),
    quotaIds: quotas.map((quota) => quota?.id ?? null),
  }
}

async function createAdopted(
  clusterId: string,
  name: string,
  isPublic: boolean,
  scanPolicy: { autoScan: boolean; autoSbom: boolean },
  seen: Sighting[]
) {
  const { storageQuotaMib, quotaIds } = await readAdoptedQuota(seen)

  return prisma.project.create({
    data: {
      name,
      clusterId,
      status: "ACTIVE",
      isPublic,
      ownerUserId: null,
      storageQuotaMib,
      autoScan: scanPolicy.autoScan,
      autoSbom: scanPolicy.autoSbom,
      placements: {
        create: seen.map((sighting, index) => ({
          registryId: sighting.member.registryId,
          harborProjectId: sighting.project.projectId,
          harborQuotaId: quotaIds[index],
          status: "ACTIVE",
          syncedAt: new Date(),
        })),
      },
    },
  })
}
