import { pickHealthyMember } from "@/lib/clusters/members"
import { logger } from "@/lib/logger"
import { searchHarborRepositories } from "./harbor"

// A project the caller is allowed to see, which is what makes this filtering and not ranking.
export interface VisibleProject {
  id: string
  name: string
  clusterId: string
  cluster: { name: string }
}

export interface ImageHit {
  projectId: string
  projectName: string
  /** Name inside the project — the full catalog name minus the "<project>/" prefix. */
  repository: string
  cluster: string
  artifactCount: number
}

export const MAX_IMAGE_RESULTS = 20

// Repositories the user may actually see, from the Harbors that hold them.
//
// Harbor answers as the Gateway's admin account, so its results cover every project on the
// instance — including ones this user has no business knowing about. The visible projects
// the caller passes in are therefore the filter, not a hint: a hit whose project is not in that map
// is dropped, never merely deprioritised.
export async function searchImages(
  query: string,
  visible: VisibleProject[]
): Promise<ImageHit[]> {
  if (visible.length === 0) return []

  const byCluster = new Map<string, VisibleProject[]>()
  for (const project of visible) {
    const bucket = byCluster.get(project.clusterId)
    if (bucket) bucket.push(project)
    else byCluster.set(project.clusterId, [project])
  }

  const perCluster = await Promise.all(
    [...byCluster.entries()].map(async ([clusterId, clusterProjects]) => {
      const member = await pickHealthyMember(clusterId)
      if (!member) return []

      let hits
      try {
        hits = await searchHarborRepositories(member.conn, query)
      } catch (err) {
        // A Harbor that will not answer must not fail the whole palette: the pages, projects
        // and registries above are still worth returning.
        logger.warn("Image search failed on a cluster", {
          clusterId,
          registryId: member.registryId,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }

      const byName = new Map(clusterProjects.map((p) => [p.name.toLowerCase(), p]))
      return hits.flatMap((hit) => {
        const project = byName.get(hit.projectName.toLowerCase())
        if (!project) return []
        return [
          {
            projectId: project.id,
            projectName: project.name,
            // Harbor returns the full catalog name; the project prefix is already shown
            // alongside, so it is stripped here rather than repeated.
            repository: hit.name.startsWith(`${hit.projectName}/`)
              ? hit.name.slice(hit.projectName.length + 1)
              : hit.name,
            cluster: project.cluster.name,
            artifactCount: hit.artifactCount,
          },
        ]
      })
    })
  )

  return perCluster
    .flat()
    .sort((a, b) => a.repository.localeCompare(b.repository))
    .slice(0, MAX_IMAGE_RESULTS)
}
