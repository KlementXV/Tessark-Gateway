import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { prisma } from "../src/lib/prisma"
import {
  capabilityFromConfig,
  describeMemberDirectory,
  recoverUnknownUser,
  searchDirectoryUsers,
  type DirectoryCapabilityView,
} from "../src/lib/clusters/directory"
import {
  compareDirectoryMembers,
  type DirectoryComparedSettings,
  type DirectoryMemberView,
} from "../src/lib/clusters/directory-view"
import {
  applyClusterDirectoryConfig,
  applyLdapConfig,
  DirectoryConfigDisabledError,
  ldapFingerprint,
} from "../src/lib/clusters/directory-config"
import { encryptSecret } from "../src/lib/crypto"
import { applyMemberToMember } from "../src/lib/clusters/project-members"
import { applyGroupToMember } from "../src/lib/clusters/project-groups"
import type { ClusterMember } from "../src/lib/clusters/members"
import {
  getHarborAuthConfig,
  HarborUnknownUserError,
  importLdapUsers,
  searchLdapGroups,
  searchLdapUsers,
} from "../src/lib/registries/harbor"

// docs/plan-ldap-sso-local.md, lot 8. The Harbor below is an in-memory double shaped on what was
// measured against a real 2.15.0 (lot 0b) — exact-match LDAP search, 404 for an unknown group,
// an import that refuses the whole batch for one unknown uid — not on what the spec suggests.

const conn = { id: "a", name: "harbor-a", baseUrl: "https://a.example.test", authType: "basic" as const, username: "admin", secret: "test", insecureTLS: false }
const member: ClusterMember = { registryId: "a", registryName: "harbor-a", role: "MANAGED", conn }

const restorers: Array<() => void> = []
function stub<T extends (...args: never[]) => unknown>(target: object, name: string, implementation: T) {
  const object = target as Record<string, unknown>
  const original = object[name]
  const fn = mock.fn(implementation)
  object[name] = fn
  restorers.push(() => { object[name] = original })
  return fn
}
afterEach(() => { for (const restore of restorers.splice(0).reverse()) restore(); mock.restoreAll() })

type Handler = (url: URL, body: unknown) => Response
/** Routes keyed "METHOD /path" below /api/v2.0. An array answers its entries in turn, the last one repeating. */
function fakeHarbor(routes: Record<string, Handler | Handler[]>) {
  const calls: Array<{ key: string; search: string; body: unknown }> = []
  const turns = new Map<string, number>()
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = `${init?.method ?? "GET"} ${url.pathname.replace("/api/v2.0", "")}`
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ key, search: url.search, body })
    const route = routes[key]
    if (!route) return Response.json({ errors: [{ message: `unexpected ${key}` }] }, { status: 599 })
    if (!Array.isArray(route)) return route(url, body)
    const turn = turns.get(key) ?? 0
    turns.set(key, turn + 1)
    return route[Math.min(turn, route.length - 1)](url, body)
  })
  return calls
}

function configurations(authMode: string, ldapUrl: string): Handler {
  return () => Response.json({
    auth_mode: { value: authMode, editable: false },
    ldap_url: { value: ldapUrl, editable: true },
    ldap_base_dn: { value: "ou=people,dc=example,dc=test", editable: true },
    ldap_uid: { value: "uid", editable: true },
    ldap_verify_cert: { value: true, editable: true },
    // Harbor does not return these today. A future release that did must still not leak them.
    ldap_search_password: { value: "bind-secret", editable: true },
    oidc_client_secret: { value: "oidc-secret", editable: true },
  })
}

const live: DirectoryCapabilityView = { capability: "ldap-live", provisioning: "on-grant", reason: null, registryId: "a", registryName: "harbor-a", authMode: "ldap_auth", detail: null }

test("the directory capability follows the LDAP settings, not auth_mode", () => {
  // Measured (M1): the LDAP searches answer on db_auth and oidc_auth as soon as ldap_* is set.
  for (const authMode of ["ldap_auth", "oidc_auth", "db_auth"]) {
    assert.equal(capabilityFromConfig({ authMode, ldap: { url: "ldaps://dc.example.test" } }).capability, "ldap-live")
    assert.equal(capabilityFromConfig({ authMode, ldap: { url: "  " } }).capability, "harbor-known")
  }
  assert.equal(capabilityFromConfig({ authMode: "ldap_auth", ldap: { url: "ldap://x" } }).provisioning, "on-grant")
  assert.equal(capabilityFromConfig({ authMode: "oidc_auth", ldap: { url: "ldap://x" } }).provisioning, "first-sign-in")
  assert.equal(capabilityFromConfig({ authMode: "db_auth", ldap: { url: "" } }).reason, "ldap-not-configured")
})

test("reading the configuration never carries a secret, whatever Harbor returns", async () => {
  fakeHarbor({ "GET /configurations": configurations("ldap_auth", "ldap://dc.example.test") })
  const config = await getHarborAuthConfig(conn)
  assert.equal(config.authMode, "ldap_auth")
  assert.equal(config.ldap.url, "ldap://dc.example.test")
  assert.equal(JSON.stringify(config).includes("bind-secret"), false)
  assert.equal(JSON.stringify(config).includes("oidc-secret"), false)
})

test("describing a member never throws: refused credentials degrade, a dead Harbor is unreachable", async () => {
  fakeHarbor({ "GET /configurations": () => new Response(null, { status: 403 }) })
  const forbidden = await describeMemberDirectory(member)
  assert.equal(forbidden.capability, "harbor-known")
  assert.equal(forbidden.reason, "configuration-unreadable")
  mock.restoreAll()

  mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed") })
  const dead = await describeMemberDirectory(member)
  assert.equal(dead.capability, "unreachable")
  assert.equal(dead.registryName, "harbor-a")
})

test("an empty directory query is never sent — Harbor would return the whole directory", async () => {
  const calls = fakeHarbor({})
  assert.deepEqual(await searchLdapUsers(conn, "  "), [])
  assert.deepEqual(await searchLdapGroups(conn, { name: "" }), [])
  assert.equal(calls.length, 0)
})

test("an unknown directory group is a 404 on Harbor and an empty list here", async () => {
  fakeHarbor({ "GET /ldap/groups/search": () => Response.json({ errors: [{ message: "not found" }] }, { status: 404 }) })
  assert.deepEqual(await searchLdapGroups(conn, { name: "ghost" }), [])
})

test("a partially refused import names the refused uid and still imports the others", async () => {
  const calls = fakeHarbor({
    "POST /ldap/users/import": (_url, body) => {
      const uids = (body as { ldap_uid_list: string[] }).ldap_uid_list
      // Measured: one unknown uid makes Harbor refuse the whole batch, the known ones included.
      if (uids.includes("nobody")) return Response.json([{ uid: "nobody", error: "unknown_user" }], { status: 404 })
      return new Response(null, { status: 200 })
    },
  })
  const outcome = await importLdapUsers(conn, ["carol", "nobody", "alice"])
  assert.deepEqual(outcome.imported, ["carol", "alice"])
  assert.deepEqual(outcome.failed, [{ uid: "nobody", error: "unknown_user" }])
  assert.equal(calls.length, 2)
  assert.deepEqual((calls[1].body as { ldap_uid_list: string[] }).ldap_uid_list, ["carol", "alice"])
})

test("a directory search returns the exact directory account and Harbor's partial matches, each with its source", async () => {
  fakeHarbor({
    "GET /users/search": (url) => {
      const name = url.searchParams.get("username")
      return Response.json(name === "ali" ? [{ user_id: 9, username: "alicia" }] : [])
    },
    "GET /ldap/users/search": (url) =>
      Response.json(url.searchParams.get("username") === "ali" ? [{ username: "ali", realname: "Ali Ben", email: "ali@example.test" }] : []),
  })
  const result = await searchDirectoryUsers(member, live, "ali", 25)
  assert.equal(result.source, "directory")
  assert.deepEqual(result.users.map((u) => [u.username, u.source, u.knownToHarbor]), [
    ["ali", "directory", false],
    ["alicia", "harbor", true],
  ])
})

test("a directory that fails is said, never silently replaced by Harbor's table", async () => {
  fakeHarbor({
    "GET /users/search": () => Response.json([{ user_id: 4, username: "bob" }]),
    "GET /ldap/users/search": () => Response.json({ errors: [{ message: "internal server error" }] }, { status: 500 }),
  })
  const result = await searchDirectoryUsers(member, live, "bob", 25)
  assert.equal(result.source, "harbor")
  assert.match(result.directoryError ?? "", /could not query its LDAP directory/)
  assert.deepEqual(result.users.map((u) => u.source), ["harbor"])
})

test("an unknown account is explained per auth_mode, and imported where the directory allows it", async () => {
  fakeHarbor({
    "GET /configurations": configurations("ldap_auth", "ldap://dc"),
    "POST /ldap/users/import": [() => new Response(null, { status: 200 }), () => Response.json([{ uid: "ghost", error: "unknown_user" }], { status: 404 })],
  })
  assert.equal(await recoverUnknownUser(member, "alice"), "imported")
  assert.equal(await recoverUnknownUser(member, "ghost"), "absent-from-directory")
  mock.restoreAll()

  const calls = fakeHarbor({ "GET /configurations": configurations("oidc_auth", "ldap://dc") })
  assert.equal(await recoverUnknownUser(member, "alice"), "not-yet-signed-in")
  assert.equal(calls.some((c) => c.key === "POST /ldap/users/import"), false)
})

test("granting a directory account Harbor does not know yet imports it and retries once", async () => {
  stub(prisma.projectPlacement, "findUnique", async () => ({ harborProjectId: 7 }))
  const calls = fakeHarbor({
    "GET /projects/7/members": () => Response.json([]),
    "POST /projects/7/members": [
      () => Response.json({ errors: [{ message: "no user found: alice" }] }, { status: 404 }),
      () => new Response(null, { status: 201, headers: { location: "/api/v2.0/projects/7/members/31" } }),
    ],
    "GET /configurations": configurations("ldap_auth", "ldap://dc"),
    "POST /ldap/users/import": () => new Response(null, { status: 200 }),
  })
  await applyMemberToMember(member, { projectId: "p", projectName: "apps", harborUsername: "alice", role: "DEVELOPER" })
  assert.deepEqual(calls.filter((c) => c.key.startsWith("POST")).map((c) => c.key), [
    "POST /projects/7/members",
    "POST /ldap/users/import",
    "POST /projects/7/members",
  ])
})

test("on an OIDC Harbor the refusal says the person has to sign in first, and names the member", async () => {
  stub(prisma.projectPlacement, "findUnique", async () => ({ harborProjectId: 7 }))
  fakeHarbor({
    "GET /projects/7/members": () => Response.json([]),
    "POST /projects/7/members": () => Response.json({ errors: [{ message: "bob not found: not supported" }] }, { status: 404 }),
    "GET /configurations": configurations("oidc_auth", ""),
  })
  await assert.rejects(
    applyMemberToMember(member, { projectId: "p", projectName: "apps", harborUsername: "bob", role: "DEVELOPER" }),
    (err: unknown) =>
      err instanceof HarborUnknownUserError && err.reason === "not-yet-signed-in" && err.message.startsWith("harbor-a has no user"),
  )
})

test("a directory group Harbor never registered is registered from the directory's DN, then granted", async () => {
  stub(prisma.projectPlacement, "findUnique", async () => ({ harborProjectId: 7 }))
  const calls = fakeHarbor({
    "GET /projects/7/members": () => Response.json([]),
    "GET /usergroups": [() => Response.json([]), () => Response.json([{ id: 4, group_name: "team-app", group_type: 1 }])],
    "GET /configurations": configurations("ldap_auth", "ldap://dc"),
    "GET /ldap/groups/search": () => Response.json([{ group_name: "team-app", ldap_group_dn: "cn=team-app,ou=groups,dc=example,dc=test" }]),
    "POST /usergroups": () => new Response(null, { status: 201, headers: { location: "/api/v2.0/usergroups/4" } }),
    "POST /projects/7/members": () => new Response(null, { status: 201, headers: { location: "/api/v2.0/projects/7/members/40" } }),
  })
  await applyGroupToMember(member, { projectId: "p", projectName: "apps", groupName: "team-app", role: "GUEST" })
  const registration = calls.find((c) => c.key === "POST /usergroups")
  assert.deepEqual(registration?.body, { group_name: "team-app", group_type: 1, ldap_group_dn: "cn=team-app,ou=groups,dc=example,dc=test" })
  assert.deepEqual(calls.find((c) => c.key === "POST /projects/7/members")?.body, { role_id: 3, member_group: { id: 4 } })
})

function view(name: string, patch: Omit<Partial<DirectoryMemberView>, "settings"> & { settings?: Partial<DirectoryComparedSettings> } = {}): DirectoryMemberView {
  const { settings, ...rest } = patch
  return {
    registryId: name,
    registryName: name,
    status: "answered",
    error: null,
    authMode: "ldap_auth",
    ldapConfigured: true,
    directoryAnswered: true,
    directoryError: null,
    ...rest,
    settings: {
      url: "ldaps://dc1.example.test",
      searchDn: "cn=svc,dc=example,dc=test",
      baseDn: "ou=people,dc=example,dc=test",
      filter: "",
      uid: "uid",
      scope: 2,
      verifyCert: true,
      groupBaseDn: "ou=groups,dc=example,dc=test",
      groupSearchFilter: "",
      groupAttributeName: "cn",
      groupMembershipAttribute: "memberof",
      ...settings,
    },
  }
}

test("two members on different base DNs are reported, naming both", () => {
  const result = compareDirectoryMembers([view("harbor-a"), view("harbor-b", { settings: { baseDn: "ou=staff,dc=example,dc=test" } })])
  assert.equal(result.verdict, "attention")
  const drift = result.drifts.find((d) => d.field === "baseDn")
  assert.deepEqual(drift?.values.map((v) => v.registries), [["harbor-a"], ["harbor-b"]])
})

test("an unreachable member is never read as a consistent configuration", () => {
  const result = compareDirectoryMembers([view("harbor-a"), view("harbor-b", { status: "unreachable", error: "timeout", settings: undefined })])
  assert.equal(result.verdict, "incomplete")
  assert.deepEqual(result.findings.map((f) => [f.kind, f.registryName]), [["unreachable", "harbor-b"]])
})

test("DN spelling and replica URLs do not raise false alarms", () => {
  const result = compareDirectoryMembers([
    view("harbor-a"),
    view("harbor-b", { settings: { url: "ldaps://dc2.example.test", baseDn: "OU=People, DC=example, DC=test" } }),
  ])
  assert.equal(result.verdict, "consistent")
  assert.deepEqual(result.drifts.map((d) => [d.field, d.severity]), [["url", "info"]])
})

test("certificate checks off, cleartext LDAP and a silent directory are flagged", () => {
  const result = compareDirectoryMembers([
    view("harbor-a", { settings: { url: "ldap://dc1.example.test", verifyCert: false } }),
    view("harbor-b", { directoryAnswered: false, directoryError: "500" }),
  ])
  assert.deepEqual(result.findings.map((f) => f.kind).sort(), ["directory-error", "plaintext", "verify-cert-off"])
  assert.equal(result.verdict, "attention")
})

// --- lot 7: writing the LDAP configuration -----------------------------------------------------

const candidate = {
  url: "ldaps://dc.example.test",
  searchDn: "cn=svc,dc=example,dc=test",
  searchPassword: "bind-password",
  baseDn: "ou=people,dc=example,dc=test",
  filter: "",
  uid: "uid",
  scope: 2,
  verifyCert: true,
  groupBaseDn: "",
  groupSearchFilter: "",
  groupAttributeName: "cn",
  groupMembershipAttribute: "memberof",
  groupSearchScope: 2,
}

function registryRow(ldapAppliedFingerprint: string | null) {
  return { id: "a", name: "harbor-a", baseUrl: conn.baseUrl, authType: "basic", username: "admin", encryptedSecret: encryptSecret("test"), insecureTLS: false, role: "MANAGED", clusterId: "c", ldapAppliedFingerprint }
}

test("a failed ping on the Harbor itself prevents any write, even under force", async () => {
  stub(prisma.registry, "findUnique", async () => registryRow(null))
  const update = stub(prisma.registry, "update", async () => ({}))
  const calls = fakeHarbor({ "POST /ldap/ping": () => Response.json({ message: "error: invalid credential" }) })
  const outcome = await applyLdapConfig("a", candidate, { force: true })
  assert.equal(outcome.status, "ping-failed")
  assert.equal(calls.some((c) => c.key === "PUT /configurations"), false)
  assert.equal(update.mock.callCount(), 0)
})

test("unchanged settings cause no network call at all, and a rotated password is a change", async () => {
  stub(prisma.registry, "findUnique", async () => registryRow(ldapFingerprint(candidate)))
  const calls = fakeHarbor({})
  assert.equal((await applyLdapConfig("a", candidate)).status, "unchanged")
  assert.equal(calls.length, 0)
  assert.notEqual(ldapFingerprint({ ...candidate, searchPassword: "rotated" }), ldapFingerprint(candidate))
})

test("a write records its fingerprint, and auth_mode is never sent to a Harbor holding accounts", async () => {
  stub(prisma.registry, "findUnique", async () => registryRow(null))
  const update = stub(prisma.registry, "update", async ({ data }: { data: Record<string, unknown> }) => ({ ...data }))
  const calls = fakeHarbor({
    "POST /ldap/ping": () => Response.json({ success: true }),
    "PUT /configurations": () => new Response(null, { status: 200 }),
    "GET /configurations": configurations("db_auth", "ldaps://dc.example.test"),
    "GET /users": () => new Response("[]", { headers: { "x-total-count": "2" } }),
  })
  const outcome = await applyLdapConfig("a", candidate, { setAuthMode: true })
  assert.deepEqual(outcome, { registryId: "a", registryName: "harbor-a", status: "applied", written: true, authMode: "locked" })
  assert.equal(update.mock.calls[0].arguments[0].data.ldapAppliedFingerprint, ldapFingerprint(candidate))
  const puts = calls.filter((c) => c.key === "PUT /configurations")
  assert.equal(puts.length, 1)
  assert.equal("auth_mode" in (puts[0].body as object), false)
})

test("a cluster that has not opted in is never written", async () => {
  stub(prisma.clusterDirectoryConfig, "findUnique", async () => ({ enabled: false }))
  const calls = fakeHarbor({})
  await assert.rejects(applyClusterDirectoryConfig("c"), DirectoryConfigDisabledError)
  assert.equal(calls.length, 0)
})
