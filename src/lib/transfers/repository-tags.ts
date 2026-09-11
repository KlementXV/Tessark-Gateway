import { registryFetch } from "@/lib/registries/http"
import type { RegistryConnection } from "@/lib/registries/types"
import { isValidRepositoryPath } from "@/lib/registries/v2-client"

export const MAX_TRANSFER_TAGS = 500
export const MAX_TAGS_TO_INSPECT = 10000

/** Complete listing or explicit failure; never silently truncate an all-tags request. */
export async function listRepositoryTags(
  conn: RegistryConnection,
  repo: string,
  fetchPage: typeof registryFetch = registryFetch,
): Promise<string[]> {
  if (!isValidRepositoryPath(repo)) throw new Error("Invalid repository path")
  const path = `/v2/${repo.split("/").map(encodeURIComponent).join("/")}/tags/list`
  let url = new URL(`${path}?n=100`, conn.baseUrl)
  const seenPages = new Set<string>()
  const tags = new Set<string>()
  // Bound the whole listing as well as its size, including registries with tiny pages.
  const signal = AbortSignal.timeout(60000)
  while (true) {
    if (seenPages.has(url.href) || seenPages.size >= MAX_TAGS_TO_INSPECT) {
      throw new Error("Registry tag pagination did not complete")
    }
    seenPages.add(url.href)
    const response = await fetchPage(conn, `${url.pathname}${url.search}`, { signal })
    if (!response.ok) throw new Error(`Tag listing failed (HTTP ${response.status})`)
    const body = await response.json() as { tags?: unknown }
    if (body.tags !== null && !Array.isArray(body.tags)) throw new Error("Invalid registry tag listing")
    for (const tag of body.tags ?? []) {
      if (typeof tag !== "string" || !/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error("Invalid tag returned by registry")
      tags.add(tag)
      if (tags.size > MAX_TAGS_TO_INSPECT) throw new Error(`Repository inspection is limited to ${MAX_TAGS_TO_INSPECT} tags; no transfers were created`)
    }
    const link = response.headers.get("link")
    if (!link) break
    const next = link.split(/,(?=\s*<)/).find(part => /;\s*rel\s*=\s*"?next"?(?:\s|;|$)/i.test(part))
    if (!next) throw new Error("Invalid registry pagination link")
    const target = /^\s*<([^>]+)>/.exec(next)?.[1]
    if (!target) throw new Error("Invalid registry pagination link")
    const nextUrl = new URL(target, url)
    // Never send registry credentials to another host or another repository's API.
    if (nextUrl.origin !== url.origin || nextUrl.pathname !== path || nextUrl.username || nextUrl.password || nextUrl.hash) {
      throw new Error("Unsafe registry pagination link")
    }
    url = nextUrl
  }
  if (!tags.size) throw new Error("This repository has no tags to transfer")
  return [...tags].sort()
}
