import { prisma } from "@/lib/prisma"
import {
  getHarborArtifactSbom,
  type HarborSbom,
  requestHarborScan,
  type HarborScanType,
  getHarborArtifactVulnerabilities,
  listHarborArtifacts,
  listHarborRepositories,
  listHarborRepositoryKinds,
  type HarborArtifact,
  type HarborRepository,
  type HarborVulnerability,
} from "@/lib/registries/harbor"
import { loadConnection } from "@/lib/registries/load"
import type { RegistryConnection } from "@/lib/registries/types"

// What a project holds is read live from Harbor rather than mirrored into the database:
// images are pushed by clients that never touch the Gateway, so anything stored here would
// be stale the moment someone runs `docker push`.

/** No Harbor in the cluster is in sync yet, so there is nothing to read the images from. */
export class NoSyncedHarborError extends Error {
  constructor(message = "No Harbor in this cluster is in sync yet") {
    super(message)
    this.name = "NoSyncedHarborError"
  }
}

interface ImageSource {
  registryId: string
  registryName: string
  conn: RegistryConnection
}

// Replication keeps every member carrying the same repositories, so one in-sync Harbor
// answers for the whole cluster — fanning out would multiply the latency to show the same
// list. The member that answered is reported alongside the result so a user looking at a
// mid-replication cluster knows whose view this is.
async function pickImageSource(projectId: string): Promise<ImageSource> {
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, status: "ACTIVE" },
    include: { registry: { select: { name: true } } },
    orderBy: { registry: { name: "asc" } },
  })

  for (const placement of placements) {
    const conn = await loadConnection(placement.registryId)
    if (conn) return { registryId: placement.registryId, registryName: placement.registry.name, conn }
  }

  throw new NoSyncedHarborError()
}

/**
 * How often a repository was pulled, across the whole cluster.
 *
 * Harbor's `pull_count` is per instance: replication carries images, never access statistics,
 * so two members of the same mesh disagree by exactly the traffic each one served. Reading it
 * from the single member that answered the listing therefore reports an arbitrary fraction of
 * the real usage — 64 on one Harbor and 0 on its peer, for the same image. Only the sum is the
 * number anyone actually means by "how often is this pulled".
 */
export interface RepositoryPulls {
  /** Sum over the members that answered. */
  total: number
  /** Per member, in name order — the breakdown is the part that explains a lopsided total. */
  byRegistry: Array<{ registryName: string; pullCount: number }>
  /**
   * Members that did not answer, so `total` is a floor rather than a count. Named rather than
   * reduced to a boolean, and said in the UI rather than left to be discovered: a total that
   * silently drops a member is worse than no total.
   */
  missing: string[]
}

export interface ProjectRepository extends HarborRepository {
  pulls: RepositoryPulls
}

export interface ProjectImages {
  registryId: string
  registryName: string
  /**
   * Host of the Harbor that answered, e.g. `harbor.local:8443` — the address an image on it
   * is actually pulled from. It is the fallback the UI uses to build a complete reference
   * when the cluster publishes no single registry host of its own.
   */
  registryHost: string | null
  repositories: ProjectRepository[]
  /** Members whose repository list could not be read, and whose pulls are missing from every total. */
  unreadable: string[]
}

/** The host part of a registry base URL, or null when it is not a parsable URL. */
function registryHostOf(baseUrl: string): string | null {
  return URL.parse(baseUrl)?.host ?? null
}

/**
 * The pull counters of every other member, read only for their numbers.
 *
 * The listing itself still comes from one member — replication keeps the repositories
 * identical, so fanning out to build the same list would only multiply the latency. Pull
 * counts are the one field where that reasoning does not hold, because they are the one field
 * replication does not carry. Verified against Harbor v2.15.0 on 2026-09-06: a replication run
 * leaves both sides' counters untouched, so summing them double-counts nothing.
 *
 * Members are read in parallel and failures are absorbed into `unreadable`: a peer that is down
 * must not cost the image list, only the completeness of its totals.
 */
async function readPullCounts(
  projectId: string,
  projectName: string,
  source: ImageSource
): Promise<{ counts: Map<string, Array<{ registryName: string; pullCount: number }>>; unreadable: string[] }> {
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, status: "ACTIVE", registryId: { not: source.registryId } },
    include: { registry: { select: { name: true } } },
    orderBy: { registry: { name: "asc" } },
  })

  const counts = new Map<string, Array<{ registryName: string; pullCount: number }>>()
  const unreadable: string[] = []

  const results = await Promise.all(
    placements.map(async (placement) => {
      const conn = await loadConnection(placement.registryId)
      if (!conn) return { registryName: placement.registry.name, repositories: null }
      try {
        return {
          registryName: placement.registry.name,
          repositories: await listHarborRepositories(conn, projectName),
        }
      } catch {
        return { registryName: placement.registry.name, repositories: null }
      }
    })
  )

  for (const result of results) {
    if (!result.repositories) {
      unreadable.push(result.registryName)
      continue
    }
    for (const repo of result.repositories) {
      const list = counts.get(repo.name) ?? []
      list.push({ registryName: result.registryName, pullCount: repo.pullCount })
      counts.set(repo.name, list)
    }
  }

  return { counts, unreadable }
}

export async function listProjectImages(projectId: string, projectName: string): Promise<ProjectImages> {
  const source = await pickImageSource(projectId)
  const repositories = await listHarborRepositories(source.conn, projectName)

  // A repository row shows an icon before anyone expands it, so the kind has to be known up
  // front. Harbor does not put it on the repository, hence one probe apiece — affordable for
  // a project, which holds a handful of repositories, and given up on beyond that.
  const [kinds, pulls] = await Promise.all([
    listHarborRepositoryKinds(source.conn, projectName, repositories.map((repo) => repo.name)),
    readPullCounts(projectId, projectName, source),
  ])

  return {
    registryId: source.registryId,
    registryName: source.registryName,
    registryHost: registryHostOf(source.conn.baseUrl),
    unreadable: pulls.unreadable,
    repositories: repositories
      .map((repo) => {
        // The answering member first: it is the one whose name the rest of the panel shows.
        const byRegistry = [
          { registryName: source.registryName, pullCount: repo.pullCount },
          ...(pulls.counts.get(repo.name) ?? []),
        ]
        return {
          ...repo,
          kind: kinds[repo.name],
          pulls: {
            total: byRegistry.reduce((sum, entry) => sum + entry.pullCount, 0),
            byRegistry,
            missing: pulls.unreadable,
          },
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export async function listProjectImageArtifacts(
  projectId: string,
  projectName: string,
  repository: string
): Promise<HarborArtifact[]> {
  const source = await pickImageSource(projectId)
  return listHarborArtifacts(source.conn, projectName, repository)
}

// The full CVE list for one artifact of this project. Reads from the same in-sync member the
// image list came from — `repository` is the bare name here, joined to the project the way
// harbor.ts expects a repo reference ("<project>/<repository>").
export async function getProjectImageVulnerabilities(
  projectId: string,
  projectName: string,
  repository: string,
  reference: string
): Promise<HarborVulnerability[] | null> {
  const source = await pickImageSource(projectId)
  return getHarborArtifactVulnerabilities(source.conn, `${projectName}/${repository}`, reference)
}

// Asks every Harbor of the cluster to scan this artifact, not just the one that answered the
// listing. A project's members hold the same image, and scanning one of them would leave the
// others reporting a stale verdict for the exact digest the user just asked about — with no
// way to tell from the UI which member's answer is on screen.
//
// Best-effort by design: an unreachable member must not fail the request. The count of
// members that accepted is returned so the UI can say so rather than imply all of them did.
export async function requestProjectImageScan(
  projectId: string,
  projectName: string,
  repository: string,
  reference: string,
  scanType: HarborScanType
): Promise<{ accepted: number; failed: { registryName: string; error: string }[] }> {
  const placements = await prisma.projectPlacement.findMany({
    where: { projectId, status: "ACTIVE" },
    include: { registry: { select: { name: true } } },
  })

  let accepted = 0
  const failed: { registryName: string; error: string }[] = []

  for (const placement of placements) {
    const conn = await loadConnection(placement.registryId)
    if (!conn) continue
    try {
      await requestHarborScan(conn, `${projectName}/${repository}`, reference, scanType)
      accepted += 1
    } catch (err) {
      failed.push({
        registryName: placement.registry.name,
        error: err instanceof Error ? err.message : "Scan request failed",
      })
    }
  }

  if (accepted === 0 && failed.length === 0) throw new NoSyncedHarborError()
  return { accepted, failed }
}

// The SBOM document for one artifact of this project, read from the same member as the rest.
export async function getProjectImageSbom(
  projectId: string,
  projectName: string,
  repository: string,
  reference: string
): Promise<HarborSbom | null> {
  const source = await pickImageSource(projectId)
  return getHarborArtifactSbom(source.conn, `${projectName}/${repository}`, reference)
}
