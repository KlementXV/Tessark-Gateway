// Where a mirrored image lands: the Harbor host, the project that owns it, and the repository
// path under it. The source side no longer needs parsing — an UpstreamSource carries the host
// and TransferRequest stores the repo and tag apart (see src/lib/sources/repo.ts).
export function buildDestinationImage(
  registryBaseUrl: string,
  projectName: string,
  targetRepo: string,
  tag: string,
): string {
  const host = new URL(registryBaseUrl).host
  return `${host}/${projectName}/${targetRepo}:${tag}`
}
