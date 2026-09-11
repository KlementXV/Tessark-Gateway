import { createHash } from "node:crypto"
import { registryFetch } from "@/lib/registries/http"
import type { RegistryConnection } from "@/lib/registries/types"
import { isValidReference, isValidRepositoryPath } from "@/lib/registries/v2-client"
import { listRepositoryTags, MAX_TRANSFER_TAGS } from "./repository-tags"

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ")

async function manifestDigest(conn: RegistryConnection, repo: string, tag: string, signal: AbortSignal): Promise<string | null> {
  if (!isValidRepositoryPath(repo) || !isValidReference(tag)) throw new Error("Invalid artifact reference")
  const response = await registryFetch(conn, `/v2/${repo.split("/").map(encodeURIComponent).join("/")}/manifests/${encodeURIComponent(tag)}`, {
    headers: { Accept: ACCEPT }, signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Manifest lookup failed (HTTP ${response.status})`)
  // Compare the top-level manifest/index bytes, never a platform-specific child or config.
  return `sha256:${createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex")}`
}

/** Registry v2 has no reverse digest->tags endpoint. Inspect manifests only, never blobs. */
export async function findArtifactTags(conn: RegistryConnection, repo: string, reference: string) {
  const signal = AbortSignal.timeout(120000)
  const digest = await manifestDigest(conn, repo, reference, signal)
  if (!digest) throw new Error(`Requested artifact ${repo}:${reference} was not found`)
  const candidates = await listRepositoryTags(conn, repo)
  const tags = new Set([reference])
  for (let offset = 0; offset < candidates.length; offset += 10) {
    const results: { tag: string; digest: string | null }[] = await Promise.all(candidates.slice(offset, offset + 10).map(async tag => ({
      tag, digest: tag === reference ? digest : await manifestDigest(conn, repo, tag, signal),
    })))
    for (const result of results) if (result.digest === digest) tags.add(result.tag)
    if (tags.size > MAX_TRANSFER_TAGS) throw new Error(`Artifact has more than ${MAX_TRANSFER_TAGS} tags`)
  }
  return { digest, tags: [...tags].sort() }
}

/** Harbor can list tags directly on the pinned artifact without inspecting other artifacts. */
export async function findHarborArtifactTags(conn: RegistryConnection, project: string, repo: string, digest: string, reference: string) {
  if (!isValidRepositoryPath(repo) || !isValidRepositoryPath(project) || project.includes("/") || !isValidReference(digest)) {
    throw new Error("Invalid artifact reference")
  }
  const path = `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeURIComponent(encodeURIComponent(repo))}/artifacts/${encodeURIComponent(digest)}/tags`
  const tags = new Set([reference])
  const signal = AbortSignal.timeout(60000)
  for (let page = 1; page <= MAX_TRANSFER_TAGS + 1; page++) {
    const response = await registryFetch(conn, `${path}?page=${page}&page_size=100`, { signal })
    if (!response.ok) throw new Error(`Artifact tag listing failed (HTTP ${response.status})`)
    const body = await response.json() as unknown
    if (!Array.isArray(body)) throw new Error("Invalid Harbor artifact tags")
    for (const entry of body) {
      if (typeof entry?.name !== "string" || !/^[\w][\w.-]{0,127}$/.test(entry.name)) throw new Error("Invalid artifact tag")
      tags.add(entry.name)
    }
    if (tags.size > MAX_TRANSFER_TAGS) throw new Error(`Artifact has more than ${MAX_TRANSFER_TAGS} tags`)
    if (body.length < 100) return { digest, tags: [...tags].sort() }
  }
  throw new Error("Artifact tag pagination did not complete")
}
