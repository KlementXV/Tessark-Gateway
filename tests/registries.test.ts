import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"

import { registryFetch } from "../src/lib/registries/http"
import { getHarborArtifactDigest } from "../src/lib/registries/harbor"
import type { RegistryConnection } from "../src/lib/registries/types"
import { deleteManifest, getManifest, listTags } from "../src/lib/registries/v2-client"

const conn: RegistryConnection = {
  id: "test",
  name: "Test registry",
  baseUrl: "https://registry.example.test",
  authType: "basic",
  username: "test-user",
  secret: "test-password",
  insecureTLS: false,
}

afterEach(() => mock.restoreAll())

test("repository traversal is rejected before contacting the registry", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}))
  for (const repo of ["../other", "project/../../other", "project/./image"]) {
    await assert.rejects(listTags(conn, repo), /Invalid repository/)
    await assert.rejects(getManifest(conn, repo, "latest"), /Invalid repository/)
    await assert.rejects(deleteManifest(conn, repo, "sha256:" + "a".repeat(64)), /Invalid repository/)
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})

test("a nested repository retains its path when fetching a manifest", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ layers: [] }, { headers: { "docker-content-digest": "sha256:" + "a".repeat(64) } }),
  )
  await getManifest(conn, "project/team/my__image--v2", "latest")
  assert.equal(String(fetchMock.mock.calls[0].arguments[0]),
    "https://registry.example.test/v2/project/team/my__image--v2/manifests/latest")
})

test("an untrusted digest cannot redirect the manifest deletion", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ layers: [] }, { headers: { "docker-content-digest": "../../../../api/v2.0/projects/1" } }),
  )
  await assert.rejects(deleteManifest(conn, "project/image", "latest"), /Invalid manifest digest/)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test("deletion by tag requires a digest instead of silently deleting the tag", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ layers: [] }))
  await assert.rejects(deleteManifest(conn, "project/image", "latest"), /Invalid manifest digest/)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test("a digest using another algorithm is deleted directly", async () => {
  const digest = "sha512:" + "b".repeat(128)
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }))
  await deleteManifest(conn, "project/image", digest)
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(fetchMock.mock.calls[0].arguments[1]?.method, "DELETE")
  assert.equal(String(fetchMock.mock.calls[0].arguments[0]),
    `https://registry.example.test/v2/project/image/manifests/${digest}`)
})

test("cancelling a registry request also cancels its token exchange", async () => {
  const controller = new AbortController()
  const reason = new DOMException("Cancelled by caller", "AbortError")
  let calls = 0
  const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    if (++calls === 1) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example.test/token"' },
      })
    }
    assert.equal(init?.signal, controller.signal)
    controller.abort(reason)
    init.signal.throwIfAborted()
    throw new Error("Token request should have aborted")
  })
  await assert.rejects(registryFetch(conn, "/v2/", { signal: controller.signal }), (err) => err === reason)
  assert.equal(fetchMock.mock.callCount(), 2)
})

test("a successful token exchange and retry share the request's deadline", async () => {
  const signals: (AbortSignal | null | undefined)[] = []
  const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal)
    if (signals.length === 1) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example.test/token",service="registry",scope="repository:project/image:pull"' },
      })
    }
    if (signals.length === 2) return Response.json({ token: "test-token" })
    return Response.json({ tags: ["latest"] })
  })
  const res = await registryFetch(conn, "/v2/project/image/tags/list")
  assert.equal(res.status, 200)
  assert.equal(signals.length, 3)
  assert.ok(signals[0] instanceof AbortSignal)
  assert.ok(signals.every((signal) => signal === signals[0]))
  assert.equal(new Headers(fetchMock.mock.calls[2].arguments[1]?.headers).get("Authorization"), "Bearer test-token")
})

test("the digest of an older tag is resolved directly without listing the first 100 artifacts", async () => {
  const digest = "sha256:" + "c".repeat(64)
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, "/api/v2.0/projects/project/repositories/team%252Fimage/artifacts/old-release")
    assert.equal(url.search, "")
    return Response.json({ digest })
  })
  assert.equal(await getHarborArtifactDigest(conn, "project", "team/image", "old-release"), digest)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test("only a missing artifact is reported as not found", async () => {
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }))
  assert.equal(await getHarborArtifactDigest(conn, "project", "image", "missing"), null)
})

test("Harbor errors remain errors instead of being reported as a missing tag", async () => {
  for (const status of [401, 403, 500, 503]) {
    mock.method(globalThis, "fetch", async () => new Response(null, { status }))
    await assert.rejects(getHarborArtifactDigest(conn, "project", "image", "latest"),
      new RegExp(`Harbor artifact request failed \\(${status}\\)`))
    mock.restoreAll()
  }
})

test("a transfer cannot pin an absent or malformed digest", async () => {
  for (const digest of [undefined, null, 42, "latest", "../../other"]) {
    mock.method(globalThis, "fetch", async () => Response.json({ digest }))
    await assert.rejects(getHarborArtifactDigest(conn, "project", "image", "latest"), /Invalid manifest digest/)
    mock.restoreAll()
  }
})
