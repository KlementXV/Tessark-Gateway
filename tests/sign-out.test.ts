import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { signOutTo } from "../src/lib/auth/sign-out"

const restorers: Array<() => void> = []
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore()
  mock.restoreAll()
})

function browser() {
  const navigations: string[] = []
  const location = {
    href: "https://gateway.example.test/projects",
    assign(url: string) { navigations.push(url) },
  }
  for (const [key, value] of Object.entries({ window: { location }, BroadcastChannel: undefined })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    restorers.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  return navigations
}

function authServer(target: () => Promise<Response>, navigations: string[], signoutFails = false) {
  const calls: string[] = []
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "https://gateway.example.test").pathname
    calls.push(path)
    assert.deepEqual(navigations, [], "navigation must wait for local sign-out")
    if (path === "/api/auth/logout-target") return target()
    if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-fixture" })
    if (path === "/api/auth/signout") {
      assert.equal(init?.method?.toUpperCase(), "POST")
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get("csrfToken"), "csrf-fixture")
      if (signoutFails) throw new Error("Sign-out unavailable")
      // Auth.js only returns a local callback URL. Federated navigation is the caller's job.
      return Response.json({ url: "https://gateway.example.test/login" })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  return calls
}

for (const destination of ["https://gateway.example.test/login", "https://sso.example.test/logout?id_token_hint=fixture"]) {
  test(`logout resolves its target before clearing the session, then navigates to ${destination}`, async () => {
    const navigations = browser()
    const calls = authServer(async () => Response.json({ url: destination }), navigations)
    await signOutTo()
    assert.deepEqual(calls, ["/api/auth/logout-target", "/api/auth/csrf", "/api/auth/signout"])
    assert.deepEqual(navigations, [destination])
  })
}

for (const [name, target] of [
  ["network failure", async () => { throw new TypeError("Failed to fetch") }],
  ["HTTP failure", async () => new Response(null, { status: 503 })],
  ["invalid JSON", async () => new Response("not JSON")],
  ["missing URL", async () => Response.json({})],
] as const) {
  test(`logout still clears the local session after a target ${name}`, async () => {
    const navigations = browser()
    const calls = authServer(target, navigations)
    await signOutTo()
    assert.ok(calls.includes("/api/auth/signout"))
    assert.deepEqual(navigations, ["/login"])
  })
}

test("logout does not navigate to the provider when local sign-out fails", async () => {
  const navigations = browser()
  authServer(async () => Response.json({ url: "https://sso.example.test/logout" }), navigations, true)
  await assert.rejects(signOutTo(), /Sign-out unavailable/)
  assert.deepEqual(navigations, [])
})
