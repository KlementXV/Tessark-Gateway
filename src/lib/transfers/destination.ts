// How a transfer destination is named, in one place.
//
// A destination is a coordinate in one of two forms (see TransferTarget in
// prisma/schema.prisma), and every surface that shows one — the admin queue, the project's
// Transfers tab, the MCP tools, the API DTO — has to render both. Doing it here keeps the
// two forms from drifting into two different vocabularies depending on which screen you are
// looking at.
//
// Deliberately free of translation: these are identifiers (a project name, a Harbor name, a
// repository path), not sentences. The surrounding label is what gets translated.

export interface DestinationRef {
  targetRepo: string | null
  destProjectName: string | null
  project: { id: string; name: string } | null
  destRegistry: { id: string; name: string } | null
}

/**
 * The destination as a single string — "apps/nginx", or "International · apps/nginx" when
 * the image leaves the Gateway's own estate.
 *
 * Prefixing the registry for the delivery form is the point: a reviewer approving a request
 * must be able to see, without opening anything, that this one is not landing in a Harbor
 * they administer.
 */
export function describeDestination(target: DestinationRef): string {
  const projectName = target.project?.name ?? target.destProjectName
  // Both coordinates null means the project or registry was deleted after the fact; the row
  // survives as history (both foreign keys are SetNull), so it still has to render.
  if (!projectName) return "—"

  const path = target.targetRepo ? `${projectName}/${target.targetRepo}` : projectName
  return target.destRegistry ? `${target.destRegistry.name} · ${path}` : path
}

/** Where the UI sends someone looking at this destination, or null when there is nowhere. */
export function destinationHref(target: DestinationRef): string | null {
  if (target.project) return `/projects/${target.project.id}`
  if (target.destRegistry) return `/registries/${target.destRegistry.id}`
  return null
}
