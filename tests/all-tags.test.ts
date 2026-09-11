import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import type { Session } from "next-auth"
import { prisma } from "@/lib/prisma"
import { listRepositoryTags, MAX_TAGS_TO_INSPECT } from "@/lib/transfers/repository-tags"
import { expandAllTags } from "@/lib/transfers/all-tags"
import { validateTransferRequest } from "@/lib/transfers/validate"
import { transferRequestCreateInputSchema, transferRequestBatchInputSchema } from "@/lib/transfers/schema"
import { parseImageList } from "@/lib/transfers/image-list"
import type { RegistryConnection } from "@/lib/registries/types"

const conn: RegistryConnection = { id: "source", name: "source", baseUrl: "https://registry.test",
  authType: "none", username: null, secret: null, insecureTLS: false }
const session = { user: { id: "user", role: "ADMIN" }, expires: "2099-01-01" } as Session
const input = { sourceId: "source", repo: "team/app", tag: "latest", allTags: true, targets: [{ projectId: "dest" }] }
const restorers: (() => void)[] = []
function stub<T extends object, K extends keyof T>(target: T, key: K, value: unknown) {
  const original = target[key]
  target[key] = value as T[K]
  restorers.push(() => { target[key] = original })
}
function restore() {
  for (const restoreOne of restorers.splice(0).reverse()) restoreOne()
  mock.restoreAll()
}
afterEach(restore)

function allowSource(allowedRepos = '["**"]') {
  const source = { id: "source", name: "source", host: "registry.test", enabled: true, authType: "none", allowedRepos,
    username: null, encryptedSecret: null }
  stub(prisma.upstreamSource, "findUnique", async () => source)
  stub(prisma.upstreamSource, "findUniqueOrThrow", async () => source)
  stub(prisma.project, "findMany", async () => [{ id: "dest", name: "destination", status: "ACTIVE", ownerUserId: "user", members: [] }])
  stub(prisma.transferRule, "findMany", async () => [{ id: "rule", sourceUpstreamId: "source", sourceRegistryId: null,
    destRegistryId: null, repoFilter: '["**"]', projectFilter: '["**"]', requiresApproval: true }])
}

test("all-tags listing follows pagination, deduplicates names and preserves tag case", async () => {
  const paths: string[] = []
  const tags = await listRepositoryTags(conn, "team/app", async (_conn, path, init) => {
    paths.push(path)
    assert.ok(init?.signal)
    return paths.length === 1
      ? Response.json({ tags: ["v1", "ReleaseA"] }, { headers: { link: '</v2/team/app/tags/list?n=100&last=v1>; rel="next"' } })
      : Response.json({ tags: ["v1", "v2"] })
  })
  assert.deepEqual(tags, ["ReleaseA", "v1", "v2"])
  assert.equal(paths[1], "/v2/team/app/tags/list?n=100&last=v1")
})

test("pagination cannot redirect credentials to another host or repository", async () => {
  for (const next of ['https://evil.test/v2/team/app/tags/list', '/v2/private/app/tags/list', 'https://user:pass@registry.test/v2/team/app/tags/list']) {
    let calls = 0
    await assert.rejects(listRepositoryTags(conn, "team/app", async () => {
      calls++
      return Response.json({ tags: ["v1"] }, { headers: { link: `<${next}>; rel="next"` } })
    }), /Unsafe/)
    assert.equal(calls, 1)
  }
})

test("listing fails explicitly for loops, excess tags, empty or malformed responses and HTTP errors", async () => {
  for (const response of [
    Response.json({ tags: [] }), Response.json({ tags: null }), Response.json({}), Response.json({ tags: ["../escape"] }),
    Response.json({ tags: Array.from({ length: MAX_TAGS_TO_INSPECT + 1 }, (_, i) => `v${i}`) }),
    new Response(null, { status: 403 }),
  ]) await assert.rejects(listRepositoryTags(conn, "team/app", async () => response))
  await assert.rejects(listRepositoryTags(conn, "team/app", async () => Response.json({ tags: ["v1"] }, {
    headers: { link: '</v2/team/app/tags/list?n=100>; rel="next"' },
  })), /pagination did not complete/)
})

test("ordinary transfers keep their tag and never list a repository", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected HTTP") })
  assert.deepEqual(await expandAllTags({ ...input, allTags: false }, session), [{ ...input, allTags: false }])
  assert.equal(fetch.mock.callCount(), 0)
})

test("source allowlists and transfer policies are enforced before listing tags", async () => {
  allowSource('["allowed/**"]')
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ tags: ["v1"] }))
  await assert.rejects(expandAllTags(input, session), /outside what/)
  assert.equal(fetch.mock.callCount(), 0)
  restore()
  allowSource()
  stub(prisma.transferRule, "findMany", async () => [])
  const secondFetch = mock.method(globalThis, "fetch", async () => Response.json({ tags: ["v1"] }))
  await assert.rejects(expandAllTags(input, session), /No transfer rule/)
  assert.equal(secondFetch.mock.callCount(), 0)
})

const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: "sha256:child" }] })
const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`
function artifactFetch() {
  return mock.method(globalThis, "fetch", async (url: URL | string) => {
    if (String(url).includes("/tags/list")) return Response.json({ tags: ["latest", "v1", "v0", "alpine"] })
    if (String(url).endsWith("/v0") || String(url).endsWith("/alpine")) return Response.json({ schemaVersion: 2, differentArtifact: true })
    return new Response(manifest)
  })
}

test("upstream latest expands only aliases of its index digest and pins every copy", async () => {
  allowSource()
  artifactFetch()
  const entries = await expandAllTags({ ...input, useCustomCa: false }, session)
  assert.deepEqual(entries.map(entry => entry.tag), ["latest", "v1"])
  for (const entry of entries) {
    assert.equal(entry.pinnedDigest, digest)
    assert.equal(entry.allTags, false)
    assert.equal(entry.useCustomCa, false)
    assert.deepEqual(entry.targets, input.targets)
    const validated = await validateTransferRequest(entry, session, { pinnedDigest: entry.pinnedDigest })
    assert.equal(validated.requiresApproval, true)
    assert.equal(validated.sourceDigest, digest)
    assert.equal(validated.sourceImage, `registry.test/team/app:${entry.tag}`)
  }
})

test("Harbor looks up tags on the selected artifact and never expands the repository", async () => {
  allowSource()
  const registry = { ...conn, role: "MANAGED", encryptedSecret: null }
  stub(prisma.registry, "findUnique", async () => registry)
  stub(prisma.registry, "findUniqueOrThrow", async () => registry)
  const requests: string[] = []
  mock.method(globalThis, "fetch", async (url: URL | string) => {
    requests.push(String(url))
    if (String(url).includes("/tags?")) {
      assert.ok(String(url).includes(encodeURIComponent(digest)))
      return Response.json([{ name: "latest" }, { name: "v1" }])
    }
    assert.ok(String(url).endsWith("/artifacts/latest"))
    return Response.json({ digest })
  })
  const entries = await expandAllTags({ sourceRegistryId: "source", sourceProjectName: "team", repo: "app",
    tag: "latest", allTags: true, targets: input.targets }, session)
  assert.equal(requests.length, 2)
  assert.deepEqual(entries.map(entry => entry.tag), ["latest", "v1"])
  // A mutable alias is never re-resolved to different content while creating the requests.
  for (const entry of entries) assert.equal((await validateTransferRequest(entry, session, { pinnedDigest: entry.pinnedDigest })).sourceDigest, digest)
  assert.equal(requests.length, 2)
})

test("API keeps the selected tag and never accepts an externally supplied pinned digest", () => {
  const parsed = transferRequestCreateInputSchema.parse({ ...input, tag: undefined })
  assert.equal(parsed.allTags, true)
  assert.equal(transferRequestBatchInputSchema.parse({ sourceId: "source", images: [{ repo: "team/app" }],
    allTags: true, targets: input.targets }).allTags, true)
  assert.equal(transferRequestCreateInputSchema.safeParse({ ...input, allTags: "true" }).success, false)
  const list = parseImageList("oci://registry.test/team/chart", {
    sources: [{ key: "upstream:source", host: "registry.test" }],
  })
  assert.equal(list.images.length, 0)
  assert.equal(list.invalid[0].reason, "syntax")
  assert.equal("pinnedDigest" in transferRequestCreateInputSchema.parse({ ...input, pinnedDigest: "evil" }), false)
})

test("MCP all-tags creates a grouped request per tag and leaves approval-required jobs pending", async () => {
  const { registerCreateTransferRequestTool } = await import("@/lib/mcp/tools/create-transfer")
  allowSource()
  artifactFetch()
  const saved: Record<string, unknown>[] = []
  stub(prisma.transferRequest, "create", async ({ data }: { data: Record<string, unknown> }) => {
    saved.push(data)
    return { ...data, id: `request-${saved.length}`, status: "PENDING" }
  })
  let handler: (value: typeof input) => Promise<unknown> = async () => { throw new Error("tool not registered") }
  const server = { registerTool(_name: string, _options: unknown, callback: typeof handler) { handler = callback } }
  registerCreateTransferRequestTool(server as unknown as Parameters<typeof registerCreateTransferRequestTool>[0], {
    session: { ...session, user: { ...session.user, role: "USER" } }, tokenId: "test-token",
  })
  const result = await handler(input) as { isError?: boolean; content: { text: string }[] }
  assert.ok(!result.isError)
  assert.equal(saved.length, 2)
  assert.ok(saved.every(row => row.sourceDigest === digest))
  assert.deepEqual(saved.map(row => row.sourceTag), ["latest", "v1"])
  assert.ok(saved[0].batchId)
  assert.equal(saved[0].batchId, saved[1].batchId)
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.transfers.length, 2)
  assert.ok(body.transfers.every((row: { status: string }) => row.status === "PENDING"))
  assert.deepEqual(body.failed, [])
})

test("a missing requested artifact never falls back to copying repository tags", async () => {
  allowSource()
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }))
  await assert.rejects(expandAllTags(input, session), /Requested artifact.*not found/)
  assert.equal(fetch.mock.callCount(), 1)
})

test("an artifact with no aliases transfers only its requested tag", async () => {
  allowSource()
  mock.method(globalThis, "fetch", async (url: URL | string) => {
    if (String(url).includes("/tags/list")) return Response.json({ tags: ["latest", "old"] })
    return new Response(String(url).endsWith("/latest") ? manifest : "different manifest")
  })
  const entries = await expandAllTags(input, session)
  assert.deepEqual(entries.map(entry => entry.tag), ["latest"])
  assert.equal(entries[0].pinnedDigest, digest)
})
