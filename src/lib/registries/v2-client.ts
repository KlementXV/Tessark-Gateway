import { registryFetch } from "./http"
import type { ManifestInfo, ManifestLayer, RegistryConnection } from "./types"

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ")

export async function ping(conn: RegistryConnection): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await registryFetch(conn, "/v2/")
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unreachable" }
  }
}

function encodeRepoPath(repo: string): string {
  if (!isValidRepositoryPath(repo)) throw new Error("Invalid repository path")
  return repo.split("/").map(encodeURIComponent).join("/")
}

// Encoding does not neutralise dot segments: encodeURIComponent("..") is still "..",
// and URL resolution removes its parent. Refuse them before constructing a request.
export function isValidRepositoryPath(repo: string): boolean {
  return repo.length > 0 && repo.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

// A manifest reference is spliced into the request path verbatim, because a registry routes
// on the decoded path and percent-encoding the colon of a digest is not something every
// implementation accepts. Verbatim splicing is only safe if the value cannot be anything but
// a reference: `new URL(path, baseUrl)` resolves "../" and would otherwise turn a crafted
// ?reference= into a call — a DELETE, even — against an arbitrary endpoint of that Harbor,
// carrying the stored admin credentials. So the grammar is checked instead of encoded: this
// is exactly the OCI distribution spec's `reference`, and every legitimate value passes
// through byte for byte.
const OCI_TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/
const OCI_DIGEST = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]{16,}$/

export function isValidReference(reference: string): boolean {
  return OCI_TAG.test(reference) || OCI_DIGEST.test(reference)
}

export function isValidDigest(digest: string): boolean {
  return OCI_DIGEST.test(digest)
}

function assertReference(reference: string): void {
  if (!isValidReference(reference)) {
    throw new Error("Invalid manifest reference — expected a tag or a digest")
  }
}

export async function listCatalog(
  conn: RegistryConnection,
  opts: { n?: number; last?: string } = {}
): Promise<{ repositories: string[]; next: string | null }> {
  const params = new URLSearchParams()
  if (opts.n) params.set("n", String(opts.n))
  if (opts.last) params.set("last", opts.last)
  const qs = params.toString()

  const res = await registryFetch(conn, `/v2/_catalog${qs ? `?${qs}` : ""}`)
  if (!res.ok) throw new Error(`Catalog request failed (${res.status})`)
  const body = (await res.json()) as { repositories: string[] }

  const link = res.headers.get("link")
  const next = link ? /last=([^&>]+)/.exec(link)?.[1] ?? null : null

  return { repositories: body.repositories ?? [], next: next ? decodeURIComponent(next) : null }
}

export async function listTags(conn: RegistryConnection, repo: string): Promise<string[]> {
  const res = await registryFetch(conn, `/v2/${encodeRepoPath(repo)}/tags/list`)
  if (!res.ok) throw new Error(`Tag list request failed (${res.status})`)
  const body = (await res.json()) as { tags: string[] | null }
  return body.tags ?? []
}

export async function getManifest(
  conn: RegistryConnection,
  repo: string,
  reference: string
): Promise<ManifestInfo> {
  assertReference(reference)
  const res = await registryFetch(conn, `/v2/${encodeRepoPath(repo)}/manifests/${reference}`, {
    headers: { Accept: MANIFEST_ACCEPT },
  })
  if (!res.ok) throw new Error(`Manifest request failed (${res.status})`)

  const digest = res.headers.get("docker-content-digest") ?? reference
  const mediaType = res.headers.get("content-type") ?? "application/vnd.docker.distribution.manifest.v2+json"
  const body = await res.json()

  // Manifest list / OCI index: no direct layers, report the child manifests as pseudo-layers.
  if (Array.isArray(body.manifests)) {
    const layers: ManifestLayer[] = body.manifests.map((m: { digest: string; size: number; mediaType: string; platform?: { architecture?: string; os?: string } }) => ({
      digest: m.digest,
      size: m.size ?? 0,
      mediaType: `${m.platform?.os ?? "?"}/${m.platform?.architecture ?? "?"}`,
    }))
    return { digest, mediaType, totalSize: layers.reduce((s, l) => s + l.size, 0), layers }
  }

  const layers: ManifestLayer[] = (body.layers ?? []).map((l: { digest: string; size: number; mediaType: string }) => ({
    digest: l.digest,
    size: l.size ?? 0,
    mediaType: l.mediaType,
  }))
  const configSize = body.config?.size ?? 0

  return {
    digest,
    mediaType,
    totalSize: configSize + layers.reduce((s, l) => s + l.size, 0),
    layers,
  }
}

export async function deleteManifest(conn: RegistryConnection, repo: string, reference: string): Promise<void> {
  assertReference(reference)
  const repoPath = encodeRepoPath(repo)
  // Deletion by tag isn't allowed by the spec — resolve the digest first if a tag was passed.
  const digest = isValidDigest(reference)
    ? reference
    : (await getManifest(conn, repo, reference)).digest

  // Registry headers are external input too. Never splice an unchecked header into a
  // credentialed DELETE, or fall back to deleting a tag when the digest header is missing.
  if (!isValidDigest(digest)) throw new Error("Invalid manifest digest returned by registry")

  const res = await registryFetch(conn, `/v2/${repoPath}/manifests/${digest}`, {
    method: "DELETE",
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed (${res.status}) — registry may not have delete enabled`)
  }
}
