// The cluster's published registry address. A leaf module with no server-only imports, so
// the cluster form validates against exactly the rule the API enforces.
//
// Stored bare — host, optionally with a port — because that is the shape an image reference
// needs: `registry.local/team-app/api:1.4`. People will nonetheless paste a full URL out of
// a browser, so both forms are accepted and normalized down to the host.

export function normalizeClusterRegistryHost(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let host: string
  try {
    const url = new URL(candidate)
    // A path, query or credentials cannot survive into an image reference, and silently
    // dropping them would store something the user did not mean.
    if (url.pathname !== "/" || url.search || url.username) return null
    host = url.host
  } catch {
    return null
  }

  return host || null
}

export function isValidClusterRegistryHost(input: string): boolean {
  return normalizeClusterRegistryHost(input) !== null
}

/** The image reference users pull, e.g. `registry.local/team-app/api:1.4`. */
export function clusterImageReference(
  registryHost: string,
  projectName: string,
  repo: string,
  tag: string,
): string {
  return `${registryHost}/${projectName}/${repo}:${tag}`
}

/**
 * The reference of an artifact that carries no tag, e.g.
 * `registry.local/team-app/api@sha256:1f3c…`. A dangling artifact is still pullable, and by
 * digest is the only way to name it.
 */
export function clusterImageDigestReference(
  registryHost: string,
  projectName: string,
  repo: string,
  digest: string,
): string {
  return `${registryHost}/${projectName}/${repo}@${digest}`
}
