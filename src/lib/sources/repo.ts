// Repository paths *within* an upstream source: how they are normalised, matched against the
// source's allowlist, and turned back into the full image reference skopeo is handed.
//
// Kept apart from src/lib/transfers/image-ref.ts, which parses a reference a user typed as one
// string. Here the host is already known — it comes from the UpstreamSource row — so there is
// nothing to guess, only a path to validate.

// Docker Hub is the one host where the short form users type is not the path the registry
// serves: `nginx` is really `library/nginx`. Normalising here rather than relying on skopeo's
// own shortname handling is what keeps the allowlist honest — otherwise `library/**` would
// let `nginx` through the registry but not through the check, or the reverse.
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"])

export function normalizeRepoPath(host: string, repo: string): string {
  const trimmed = repo.trim().replace(/^\/+|\/+$/g, "").toLowerCase()
  if (!trimmed) return ""
  if (DOCKER_HUB_HOSTS.has(host.toLowerCase()) && !trimmed.includes("/")) {
    return `library/${trimmed}`
  }
  return trimmed
}

// The allowlist is stored as a JSON array of globs in a text column (SQLite has no JSON type).
// A row written by hand or left over from an older shape must not take the feature down, so a
// value that doesn't parse into a list of strings is treated as "nothing allowed" — a source
// nobody can pull from is recoverable by editing it; one that silently allows everything is
// the failure this whole feature exists to prevent.
export function parseAllowedRepos(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  } catch {
    return []
  }
}

// `*` matches within one path segment, `**` crosses separators — the same convention Harbor
// and .gitignore use, so "library/**" reads the way an admin expects.
function globToRegExp(glob: string): RegExp {
  const escapeLiteral = (part: string) => part.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
  const body = glob
    .toLowerCase()
    .split("**")
    .map((chunk) => chunk.split("*").map(escapeLiteral).join("[^/]*"))
    .join(".*")
  return new RegExp(`^${body}$`)
}

export function isRepoAllowed(repo: string, allowedRepos: string[]): boolean {
  return allowedRepos.some((glob) => globToRegExp(glob).test(repo))
}

export function buildSourceImageRef(host: string, repo: string, tag: string): string {
  return `${host}/${repo}:${tag}`
}

// The last path segment — the default repository name on the destination side when the
// requester doesn't give one ("library/nginx" → "nginx").
export function shortRepoName(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1)
}
