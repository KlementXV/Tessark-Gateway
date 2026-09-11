import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { Prisma, Role } from "../src/generated/prisma/client"
import { deriveUsername, OidcRefusal, resolveRole, upsertOidcUser } from "../src/lib/auth/oidc"
import { getConfig } from "../src/lib/config"
import { prisma } from "../src/lib/prisma"

// docs/plan-ldap-sso-local.md, lot 8: every invariant of src/lib/auth/oidc.ts gets a test that
// fails when it is violated. Prisma is stubbed, as elsewhere in this suite.

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

function config(patch: Partial<ReturnType<typeof getConfig>> = {}) {
  return {
    ...getConfig(),
    oidcIssuer: "https://sso.example.test",
    oidcRoleClaim: "groups",
    oidcRoleMapping: { "gateway-admins": Role.ADMIN, "gateway-owners": Role.SUPERADMIN },
    oidcDefaultRole: Role.USER,
    oidcAllowSignup: true,
    oidcLinkByEmail: false,
    ...patch,
  }
}

type Where = { where: { externalId?: string; email?: string; username?: string } }

function isRefusal(code: string) {
  return (err: unknown) => err instanceof OidcRefusal && err.code === code
}

test("Dex group claims grant the highest exactly mapped role", () => {
  const cfg = config()
  assert.equal(resolveRole({ groups: ["gateway-admins", "gateway-owners"] }, cfg), Role.SUPERADMIN)
  assert.equal(resolveRole({ groups: "gateway-admins" }, cfg), Role.ADMIN)
  assert.equal(resolveRole({ groups: ["/gateway-admins"] }, cfg), Role.USER)
  assert.equal(resolveRole({ groups: ["unknown", null, 42] }, cfg), Role.USER)
  assert.equal(resolveRole({}, cfg), Role.USER)
  assert.equal(resolveRole({ groups: ["/gateway-admins"] }, config({ oidcRoleMapping: { "/gateway-admins": Role.ADMIN } })), Role.ADMIN)
})

test("an explicit role match overrides a more privileged default", () => {
  const cfg = config({ oidcDefaultRole: Role.SUPERADMIN, oidcRoleMapping: { readers: Role.USER, admins: Role.ADMIN } })
  assert.equal(resolveRole({ groups: ["readers"] }, cfg), Role.USER)
  assert.equal(resolveRole({ groups: ["readers", "admins"] }, cfg), Role.ADMIN)
  assert.equal(resolveRole({ groups: ["unknown"] }, cfg), Role.SUPERADMIN)
  assert.equal(resolveRole({}, cfg), Role.SUPERADMIN)
  assert.equal(resolveRole({ groups: ["constructor", "toString", "__proto__"] }, cfg), Role.SUPERADMIN)
})

test("an empty mapping preserves manually assigned roles while refreshing the profile", async () => {
  const existing = { id: "u1", role: Role.ADMIN, disabled: false, name: "Old name" }
  stub(prisma.user, "findUnique", async () => existing)
  stub(prisma.user, "update", async ({ data }: { data: object }) => ({ ...existing, ...data }))
  const user = await upsertOidcUser({ sub: "s1", name: "New name" }, config({ oidcRoleMapping: {} }))
  assert.equal(user.role, Role.ADMIN)
  assert.equal(user.name, "New name")
})

test("an empty mapping still assigns the default role to a new account", async () => {
  stub(prisma.user, "findUnique", async () => null)
  stub(prisma.user, "create", async ({ data }: { data: object }) => ({ id: "new", ...data }))
  const user = await upsertOidcUser({ sub: "new-subject" }, config({ oidcRoleMapping: {}, oidcDefaultRole: Role.ADMIN }))
  assert.equal(user.role, Role.ADMIN)
})

test("a disabled account is refused even with a valid token, and nothing is written", async () => {
  stub(prisma.user, "findUnique", async ({ where }: Where) =>
    where.externalId === "https://sso.example.test|s1" ? { id: "u1", role: Role.USER, disabled: true } : null)
  const update = stub(prisma.user, "update", async () => { throw new Error("must not write") })
  await assert.rejects(upsertOidcUser({ sub: "s1", groups: ["gateway-owners"] }, config()), isRefusal("OidcAccountDisabled"))
  assert.equal(update.mock.callCount(), 0)
})

test("the role mapping never demotes the last active SUPERADMIN, and demotes any other", async () => {
  stub(prisma.user, "findUnique", async () => ({ id: "u1", role: Role.SUPERADMIN, disabled: false }))
  const update = stub(prisma.user, "update", async ({ data }: { data: { role: Role } }) => ({ id: "u1", ...data }))

  stub(prisma.user, "count", async () => 0)
  await upsertOidcUser({ sub: "s1", groups: [] }, config())
  assert.equal(update.mock.calls[0].arguments[0].data.role, Role.SUPERADMIN)

  stub(prisma.user, "count", async () => 1)
  await upsertOidcUser({ sub: "s1", groups: [] }, config())
  assert.equal(update.mock.calls[1].arguments[0].data.role, Role.USER)
})

test("an email already used by another account is refused unless linking is on and the email verified", async () => {
  stub(prisma.user, "findUnique", async ({ where }: Where) =>
    where.email === "alice@example.test" ? { id: "local", authProvider: "local", externalId: null, role: Role.USER, disabled: false } : null)
  const update = stub(prisma.user, "update", async ({ data }: { data: object }) => ({ id: "local", ...data }))
  const claims = { sub: "s2", email: "alice@example.test" }

  await assert.rejects(upsertOidcUser(claims, config()), isRefusal("OidcAccountExists"))
  await assert.rejects(upsertOidcUser(claims, config({ oidcLinkByEmail: true })), isRefusal("OidcEmailUnverified"))
  assert.equal(update.mock.callCount(), 0)

  await upsertOidcUser({ ...claims, email_verified: true }, config({ oidcLinkByEmail: true }))
  const data = update.mock.calls[0].arguments[0].data as { passwordHash: null; externalId: string }
  // A linked account stops being local: a leftover hash would be a way around the provider.
  assert.equal(data.passwordHash, null)
  assert.equal(data.externalId, "https://sso.example.test|s2")
})

for (const identity of [
  { authProvider: "oidc", externalId: "https://sso.example.test|original" },
  { authProvider: "ldap", externalId: null },
  { authProvider: "local", externalId: "https://sso.example.test|original" },
]) {
  test(`email linking refuses an already external account: ${JSON.stringify(identity)}`, async () => {
    stub(prisma.user, "findUnique", async ({ where }: Where) =>
      where.email ? { id: "existing", role: Role.USER, disabled: false, ...identity } : null)
    const update = stub(prisma.user, "update", async () => { throw new Error("must not write") })
    await assert.rejects(
      upsertOidcUser({ sub: "other", email: "alice@example.test", email_verified: true }, config({ oidcLinkByEmail: true })),
      isRefusal("OidcAccountExists"),
    )
    assert.equal(update.mock.callCount(), 0)
  })
}

test("email migration preserves a local role when no mapping is configured", async () => {
  const local = { id: "local", authProvider: "local", externalId: null, role: Role.ADMIN, disabled: false }
  stub(prisma.user, "findUnique", async ({ where }: Where) => where.email ? local : null)
  stub(prisma.user, "update", async ({ data }: { data: object }) => ({ ...local, ...data }))
  const user = await upsertOidcUser(
    { sub: "s2", email: "alice@example.test", email_verified: true },
    config({ oidcLinkByEmail: true, oidcRoleMapping: {} }),
  )
  assert.equal(user.role, Role.ADMIN)
  assert.equal(user.authProvider, "oidc")
  assert.equal(user.passwordHash, null)
})

test("concurrent email migrations cannot overwrite the identity linked first", async () => {
  const initial = { id: "local", authProvider: "local", externalId: null as string | null, role: Role.USER, disabled: false }
  let stored = { ...initial }
  // Both requests see the same local account before either writes it.
  stub(prisma.user, "findUnique", async ({ where }: Where) => where.email ? { ...initial } : null)
  stub(prisma.user, "update", async ({ where, data }: { where: Record<string, unknown>; data: typeof stored }) => {
    const matches = (filter: Record<string, unknown>): boolean => Object.entries(filter).every(([key, value]) =>
      key === "AND" ? matches(value as Record<string, unknown>) : stored[key as keyof typeof stored] === value)
    if (!matches(where)) {
      throw new Prisma.PrismaClientKnownRequestError("Account changed", { code: "P2025", clientVersion: "6.19.2" })
    }
    stored = { ...stored, ...data }
    return stored
  })
  const cfg = config({ oidcLinkByEmail: true })
  const outcomes = await Promise.allSettled(["first", "second"].map((sub) =>
    upsertOidcUser({ sub, email: "alice@example.test", email_verified: true }, cfg)))
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
  const refused = outcomes.find((outcome) => outcome.status === "rejected")
  assert.ok(refused?.status === "rejected" && isRefusal("OidcAccountExists")(refused.reason))
  assert.equal(stored.externalId, "https://sso.example.test|first")
})

test("a subject is never matched on email, and an unknown one is refused when sign-up is off", async () => {
  stub(prisma.user, "findUnique", async () => null)
  await assert.rejects(upsertOidcUser({ sub: "s3", email: "new@example.test" }, config({ oidcAllowSignup: false })), isRefusal("OidcSignupDisabled"))
  await assert.rejects(upsertOidcUser({ email: "new@example.test" }, config()), isRefusal("OidcMissingSubject"))
})

test("a derived username is normalized and suffixed until free", async () => {
  const taken = new Set(["alice-martin", "alice-martin-2"])
  stub(prisma.user, "findUnique", async ({ where }: Where) => (taken.has(where.username ?? "") ? { id: "x" } : null))
  assert.equal(await deriveUsername({ preferred_username: "Alice Martin!" }), "alice-martin-3")
  assert.equal(await deriveUsername({ preferred_username: "ab" }), "ab-user")
  assert.equal(await deriveUsername({ email: "Bob.Durand@example.test" }), "bob.durand")
})
