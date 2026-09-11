/**
 * What a conformance campaign actually does to a Harbor.
 *
 * Every scenario goes through the Gateway's own client (src/lib/registries/harbor.ts) rather than
 * a parallel HTTP client written for the tests. That is the whole point of tying a proof to a
 * Gateway commit: what is certified is *our* code against *that* Harbor, not the REST API in the
 * abstract. A scenario that reimplements the call proves nothing about the application.
 *
 * Scenarios own their resources and clean them up. Anything they create is named
 * `tessark-conf-*`, so a crashed run leaves something identifiable rather than a mystery.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

import {
  createHarborProject,
  createHarborRetentionPolicy,
  createHarborRobotAccount,
  deleteHarborProject,
  deleteHarborRobotAccount,
  findHarborProjectIdByName,
  findHarborProjectMember,
  getHarborProjectQuota,
  getHarborVersion,
  harborPing,
  listHarborProjects,
  listHarborRepositories,
  listHarborUserGroups,
  applyHarborProjectMember,
  removeHarborProjectMember,
  searchHarborUsers,
  setHarborProjectMetadata,
  setHarborProjectQuota,
  updateHarborRetentionPolicy,
  listHarborArtifacts,
  DEFAULT_ROBOT_PERMISSIONS,
  HARBOR_ROLE_DEVELOPER,
  HarborUnknownUserError,
  createHarborRegistryEndpoint,
  createHarborReplicationPolicy,
  deleteHarborArtifact,
  deleteHarborRegistryEndpoint,
  deleteHarborReplicationPolicy,
  disableHarborReplicationPolicy,
  getHarborArtifactDetail,
  getHarborArtifactSbom,
  pingHarborRegistryEndpoint,
  requestHarborScan,
  updateHarborRegistryEndpoint,
} from "../../src/lib/registries/harbor"
import {
  countHarborUsers,
  getHarborAuthConfig,
  importLdapUsers,
  pingHarborLdap,
  putHarborLdapConfig,
  searchLdapGroups,
  searchLdapUsers,
  type HarborLdapCandidate,
} from "../../src/lib/registries/harbor"
import { registryFetch } from "../../src/lib/registries/http"
import type { RegistryConnection } from "../../src/lib/registries/types"
import { resolveLdapFixture, type LdapFixture } from "./target"

/** The LDAP fixture, or a skip naming what is missing. */
function requireLdap(what: string): LdapFixture {
  const fixture = resolveLdapFixture()
  if (!fixture) throw new ScenarioUnavailable(`${what} needs HARBOR_CONFORMANCE_LDAP_URL and _KNOWN_UID`)
  return fixture
}

function fixtureCandidate(fixture: LdapFixture, password = fixture.password): HarborLdapCandidate {
  return {
    url: fixture.url,
    searchDn: fixture.searchDn,
    searchPassword: password,
    baseDn: fixture.baseDn,
    filter: "",
    uid: fixture.uid,
    scope: 2,
    verifyCert: false,
    groupBaseDn: fixture.groupBaseDn,
    groupSearchFilter: "",
    groupAttributeName: "cn",
    groupMembershipAttribute: "memberof",
    groupSearchScope: 2,
  }
}

/** The Harbor's own directory settings, or a skip when it has none. */
async function requireConfiguredDirectory(conn: RegistryConnection) {
  const config = await getHarborAuthConfig(conn)
  if (!config.ldap.url) throw new ScenarioUnavailable("this Harbor has no LDAP directory configured")
  return config
}

export interface ScenarioContext {
  conn: RegistryConnection
  /** A project created for this campaign and deleted after it. */
  scratchProjectName: string
  scratchProjectId: number
  version: string
}

export interface Scenario {
  id: string
  capabilityId: string
  run: (context: ScenarioContext) => Promise<void>
}

/** Thrown by a scenario that cannot run here — recorded as skipped, never as a failure. */
export class ScenarioUnavailable extends Error {}

/**
 * A real non-admin account this Harbor knows, for the scenarios that need one.
 *
 * Setup, not assertion: it reads `/users` (admin-only) directly rather than through the Gateway
 * client, which has no reason to enumerate a directory — the Gateway only ever *searches* one.
 * An instance with no account but `admin` cannot exercise these paths, and says so as a skip.
 */
async function findDirectoryCandidate(conn: RegistryConnection): Promise<string> {
  const res = await registryFetch(conn, "/api/v2.0/users?page_size=50")
  if (!res.ok) throw new ScenarioUnavailable(`cannot enumerate the directory (HTTP ${res.status})`)
  const users = (await res.json()) as Array<{ username?: string }>
  const candidate = users.map((user) => user.username).find((name) => name && name !== "admin")
  if (!candidate) throw new ScenarioUnavailable("this Harbor holds no account other than admin")
  return candidate
}

/**
 * An image inside the scratch project, with two tags on one digest.
 *
 * Copied *within the same Harbor* with skopeo rather than pulled from the internet: the campaign
 * must not depend on Docker Hub being reachable, and an instance that holds no image at all
 * cannot exercise these paths anyway. Deliberately not `--all`: a multi-arch index has no
 * `sbom_digest` of its own (harbor.ts documents this), so copying one platform is what makes the
 * SBOM scenario meaningful rather than vacuously null.
 *
 * Memoised per campaign: scenarios may run in any order and each one asks for the fixture it
 * needs, rather than depending on a previous scenario having run.
 */
const scratchImages = new Map<string, { repo: string; digest: string; tags: string[] }>()

/**
 * Destructive scenarios get their own repository, on purpose.
 *
 * Measured on 2.15.0 while writing this suite: deleting an artifact and re-pushing the *same
 * digest* into the *same repository* twice, then asking for a scan, makes the re-pushed artifact
 * disappear within seconds — while a single delete-then-re-push survives, and a push-then-scan
 * survives. Whatever Harbor is doing there, a suite that shares one digest between the deletion
 * scenarios and the scanning ones is testing that race rather than what it meant to test.
 */
export const DELETE_REPO = "conformance-delete"
export const SCAN_REPO = "conformance-scan"

async function ensureScratchImage(
  context: ScenarioContext,
  repository: string = SCAN_REPO,
): Promise<{ repo: string; digest: string; tags: string[] }> {
  const cached = scratchImages.get(repository)
  if (cached) return cached
  if (!skopeoAvailable()) throw new ScenarioUnavailable("skopeo is not installed on this host")

  const source = await findSourceImage(context.conn)
  const host = new URL(context.conn.baseUrl).host
  const insecure = context.conn.baseUrl.startsWith("http://") || context.conn.insecureTLS
  const credentials = context.conn.username ? `${context.conn.username}:${context.conn.secret ?? ""}` : null
  const target = `${context.scratchProjectName}/${repository}`

  for (const tag of ["a", "b"]) {
    execFileSync(
      "skopeo",
      [
        "copy",
        ...(insecure ? ["--src-tls-verify=false", "--dest-tls-verify=false"] : []),
        ...(credentials ? ["--src-creds", credentials, "--dest-creds", credentials] : []),
        `docker://${host}/${source}`,
        `docker://${host}/${target}:${tag}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
    )
  }

  const artifacts = await listHarborArtifacts(context.conn, context.scratchProjectName, repository)
  const artifact = artifacts.find((entry) => entry.tags.includes("a"))
  if (!artifact) throw new ScenarioUnavailable("the copied image did not appear in the scratch project")
  const image = { repo: target, digest: artifact.digest, tags: artifact.tags }
  scratchImages.set(repository, image)
  return image
}

function skopeoAvailable(): boolean {
  try {
    execFileSync("skopeo", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** Any tagged image already on this Harbor, to copy from. */
async function findSourceImage(conn: RegistryConnection): Promise<string> {
  for (const project of (await listHarborProjects(conn)).filter((entry) => entry.repoCount > 0)) {
    for (const repository of await listHarborRepositories(conn, project.name)) {
      const artifacts = await listHarborArtifacts(conn, project.name, repository.name)
      // A chart is not an image: skopeo cannot copy it, and neither Trivy nor Cosign apply.
      const image = artifacts.find((artifact) => artifact.kind === "image" && artifact.tags.length > 0)
      if (image) return `${project.name}/${repository.name}:${image.tags[0]}`
    }
  }
  throw new ScenarioUnavailable("this Harbor holds no tagged image to copy from")
}

/** Waits for Harbor to finish a scan it was asked for, or gives up saying so. */
async function waitForScan(
  context: ScenarioContext,
  repo: string,
  reference: string,
  done: (detail: Awaited<ReturnType<typeof getHarborArtifactDetail>>) => boolean,
  timeoutMs = 180_000,
): Promise<NonNullable<Awaited<ReturnType<typeof getHarborArtifactDetail>>>> {
  const deadline = Date.now() + timeoutMs
  let detail = await getHarborArtifactDetail(context.conn, repo, reference)
  while (Date.now() < deadline) {
    if (detail && done(detail)) return detail
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    detail = await getHarborArtifactDetail(context.conn, repo, reference)
  }
  // A scanner that never answers is an environment problem, not a Harbor incompatibility — but
  // the timeout has to say what it last saw, or it diagnoses nothing at all.
  const seen = detail
    ? `vulnerabilities=${detail.vulnerabilities?.scanStatus ?? "none"}, sbom=${String(detail.supplyChain?.sbom)}`
    : `the artifact at ${repo}@${reference.slice(0, 19)}… was not readable`
  throw new ScenarioUnavailable(`the scanner did not finish within ${timeoutMs / 1000}s (${seen})`)
}

/** The peer Harbor a replication scenario replicates *to*, as the source Harbor must reach it. */
function peerEndpointInput(): { url: string; username: string | null; secret: string | null } {
  /* eslint-disable no-restricted-syntax -- harness, not application code */
  const url = process.env.HARBOR_CONFORMANCE_PEER_URL
  if (!url) {
    throw new ScenarioUnavailable(
      "no peer configured — set HARBOR_CONFORMANCE_PEER_URL to a Harbor the *target* can reach",
    )
  }
  return {
    url,
    username: process.env.HARBOR_CONFORMANCE_PEER_USERNAME ?? null,
    secret: process.env.HARBOR_CONFORMANCE_PEER_PASSWORD ?? null,
  }
  /* eslint-enable no-restricted-syntax */
}

/** Replication objects to remove even if a scenario throws halfway through. */
export const leftoverReplication: { endpointId: number | null; policyId: number | null } = {
  endpointId: null,
  policyId: null,
}

/** Reads a policy back, to check what a write actually left behind. */
async function readReplicationPolicy(conn: RegistryConnection, policyId: number): Promise<Record<string, unknown>> {
  const res = await registryFetch(conn, `/api/v2.0/replication/policies/${policyId}`)
  if (!res.ok) throw new Error(`could not read replication policy ${policyId} (HTTP ${res.status})`)
  return (await res.json()) as Record<string, unknown>
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "identity/ping",
    capabilityId: "harbor-identity",
    run: async ({ conn }) => {
      assert.equal(await harborPing(conn), true, "/api/v2.0/ping did not answer Pong")
    },
  },
  {
    id: "identity/version-read",
    capabilityId: "harbor-identity",
    run: async ({ conn }) => {
      const version = await getHarborVersion(conn)
      assert.ok(version, "an authenticated /systeminfo must carry harbor_version")
      assert.match(version, /^v?\d+\.\d+/)
    },
  },
  {
    id: "projects/create-delete",
    capabilityId: "project-lifecycle",
    run: async ({ conn }) => {
      const name = `tessark-conf-${Math.random().toString(16).slice(2, 10)}`
      const id = await createHarborProject(conn, name, { public: false })
      try {
        assert.equal(await findHarborProjectIdByName(conn, name), id, "lookup by name must find it")
        assert.ok((await listHarborProjects(conn)).some((project) => project.name === name))
      } finally {
        await deleteHarborProject(conn, id)
      }
      assert.equal(await findHarborProjectIdByName(conn, name), null, "the project must be gone")
    },
  },
  {
    id: "projects/metadata-merge",
    capabilityId: "project-lifecycle",
    run: async ({ conn, scratchProjectName }) => {
      // harbor.ts claims Harbor merges project metadata rather than replacing it, and sends
      // partial objects on that basis. If it ever stopped being true, one PUT would silently
      // reset `public` on every project the Gateway touches.
      const before = (await listHarborProjects(conn)).find((project) => project.name === scratchProjectName)!
      await setHarborProjectMetadata(conn, scratchProjectName, { autoScan: true })
      const after = (await listHarborProjects(conn)).find((project) => project.name === scratchProjectName)!
      assert.equal(after.autoScan, true, "auto_scan should have been set")
      assert.equal(after.isPublic, before.isPublic, "a partial PUT must not reset public")
      await setHarborProjectMetadata(conn, scratchProjectName, { autoScan: false })
    },
  },
  {
    id: "sbom/enable",
    capabilityId: "sbom-generation",
    run: async ({ conn, scratchProjectName }) => {
      await setHarborProjectMetadata(conn, scratchProjectName, { autoSbom: true })
      const project = (await listHarborProjects(conn)).find((entry) => entry.name === scratchProjectName)!
      assert.equal(project.autoSbom, true, "auto_sbom_generation should read back as set")
      await setHarborProjectMetadata(conn, scratchProjectName, { autoSbom: false })
    },
  },
  {
    id: "sbom/metadata-merge-preserves-siblings",
    capabilityId: "sbom-generation",
    run: async ({ conn, scratchProjectName }) => {
      // The reason the SBOM key is a version question at all: it travels in the same PUT as
      // auto_scan, so a rejected key would take scan-on-push down with it.
      await setHarborProjectMetadata(conn, scratchProjectName, { autoScan: true })
      await setHarborProjectMetadata(conn, scratchProjectName, { autoSbom: true })
      const project = (await listHarborProjects(conn)).find((entry) => entry.name === scratchProjectName)!
      assert.equal(project.autoScan, true, "setting the SBOM key must not clear auto_scan")
      assert.equal(project.autoSbom, true)
      await setHarborProjectMetadata(conn, scratchProjectName, { autoScan: false, autoSbom: false })
    },
  },
  {
    id: "directory/user-search",
    capabilityId: "directory-identity",
    run: async ({ conn }) => {
      // harbor.ts records two measured quirks of /users/search that the Gateway depends on:
      // Harbor never returns its own `admin` account, and the match is a case-sensitive
      // substring. Both only matter to a caller that reads an empty result as "no such account"
      // — which is exactly what the membership path does. So they are the assertions.
      assert.deepEqual(await searchHarborUsers(conn, "admin"), [], "Harbor should never return its own admin")

      const candidate = await findDirectoryCandidate(conn)
      const found = await searchHarborUsers(conn, candidate)
      assert.ok(
        found.some((user) => user.username === candidate),
        `${candidate} exists in this Harbor but the directory search did not return it`,
      )
      assert.deepEqual(
        await searchHarborUsers(conn, candidate.toUpperCase()),
        [],
        "the search is case-sensitive; if that changed, the membership path changed with it",
      )
    },
  },
  {
    id: "directory/group-list",
    capabilityId: "directory-identity",
    run: async ({ conn }) => {
      // An empty directory is a valid answer here; what must hold is that the call succeeds and
      // returns a shape we can read. A local-auth Harbor legitimately has no groups.
      const groups = await listHarborUserGroups(conn)
      assert.ok(Array.isArray(groups))
    },
  },
  {
    id: "directory/ldap-config-read",
    capabilityId: "ldap-directory",
    run: async ({ conn }) => {
      const config = await getHarborAuthConfig(conn)
      assert.ok(["db_auth", "ldap_auth", "oidc_auth", "http_auth", "uaa_auth"].includes(config.authMode), `unexpected auth_mode "${config.authMode}"`)
      // The bind password is write-only in Harbor's API; the whole diagnostic design relies on it.
      const raw = await (await registryFetch(conn, "/api/v2.0/configurations")).json() as Record<string, unknown>
      assert.equal("ldap_search_password" in raw, false, "Harbor started returning the LDAP bind password")
    },
  },
  {
    id: "directory/ldap-user-search-exact",
    capabilityId: "ldap-directory",
    run: async ({ conn }) => {
      const fixture = requireLdap("the exact-match search")
      await requireConfiguredDirectory(conn)
      const found = await searchLdapUsers(conn, fixture.knownUid)
      assert.ok(found.some((user) => user.username === fixture.knownUid), `${fixture.knownUid} is in the directory but was not found`)
      // Measured on 2.15.0: the match is exact. The pickers tell users so; if Harbor turned it
      // into a substring search, that sentence would become false.
      const partial = await searchLdapUsers(conn, fixture.knownUid.slice(0, -1))
      assert.equal(partial.some((user) => user.username === fixture.knownUid), false, "the directory search became a partial match")
    },
  },
  {
    id: "directory/ldap-group-search",
    capabilityId: "ldap-directory",
    run: async ({ conn }) => {
      const fixture = requireLdap("the group search")
      if (!fixture.groupName) throw new ScenarioUnavailable("needs HARBOR_CONFORMANCE_LDAP_GROUP")
      await requireConfiguredDirectory(conn)
      const [group] = await searchLdapGroups(conn, { name: fixture.groupName })
      assert.ok(group, `${fixture.groupName} is in the directory but was not found`)
      const byDn = await searchLdapGroups(conn, { dn: group.dn })
      assert.equal(byDn[0]?.name, fixture.groupName)
      // Measured: an unknown group is a 404 on Harbor, which the client turns into an empty list.
      assert.deepEqual(await searchLdapGroups(conn, { name: `tessark-conf-nogroup-${Date.now()}` }), [])
    },
  },
  {
    id: "directory/ldap-import-idempotent",
    capabilityId: "ldap-directory",
    run: async ({ conn }) => {
      const fixture = requireLdap("the import")
      const config = await requireConfiguredDirectory(conn)
      if (config.authMode !== "ldap_auth") {
        throw new ScenarioUnavailable(`import only works on ldap_auth (this Harbor is ${config.authMode})`)
      }
      // Leaves the known account imported on this Harbor: an import has no undo short of deleting
      // the user, and the account is the fixture's, not the campaign's.
      assert.deepEqual((await importLdapUsers(conn, [fixture.knownUid])).failed, [])
      assert.deepEqual((await importLdapUsers(conn, [fixture.knownUid])).failed, [], "importing twice must be harmless")
      const nobody = `tessark-conf-nobody-${Date.now()}`
      const mixed = await importLdapUsers(conn, [fixture.knownUid, nobody])
      assert.deepEqual(mixed.imported, [fixture.knownUid], "a refused uid must not take its neighbours down")
      assert.deepEqual(mixed.failed.map((entry) => entry.uid), [nobody])
    },
  },
  {
    id: "directory/ldap-ping-candidate",
    capabilityId: "ldap-config-write",
    run: async ({ conn }) => {
      const fixture = requireLdap("the directory ping")
      assert.equal((await pingHarborLdap(conn, fixtureCandidate(fixture))).success, true, "the fixture directory should bind")
      const wrong = await pingHarborLdap(conn, fixtureCandidate(fixture, `${fixture.password}-wrong`))
      assert.equal(wrong.success, false, "a wrong bind password must fail the ping — the write gate relies on it")
    },
  },
  {
    id: "directory/ldap-config-write",
    capabilityId: "ldap-config-write",
    run: async ({ conn }) => {
      const fixture = requireLdap("the configuration write")
      if (!fixture.allowWrite) throw new ScenarioUnavailable("writing the target's configuration needs HARBOR_CONFORMANCE_LDAP_WRITE=true")
      assert.ok((await countHarborUsers(conn)) >= 0)
      await putHarborLdapConfig(conn, fixtureCandidate(fixture))
      const config = await getHarborAuthConfig(conn)
      assert.equal(config.ldap.url, fixture.url)
      assert.equal(config.ldap.baseDn, fixture.baseDn)
      assert.equal(config.ldap.uid, fixture.uid)
      // The password cannot be read back; a search that binds with it is the only proof it landed.
      const found = await searchLdapUsers(conn, fixture.knownUid)
      assert.ok(found.some((user) => user.username === fixture.knownUid), "the written bind password does not work")
    },
  },
  {
    id: "members/grant-revoke",
    capabilityId: "project-members",
    run: async ({ conn, scratchProjectId, scratchProjectName }) => {
      const username = await findDirectoryCandidate(conn)
      await applyHarborProjectMember(conn, scratchProjectId, username, HARBOR_ROLE_DEVELOPER)
      const member = await findHarborProjectMember(conn, scratchProjectId, username)
      assert.ok(member, `${username} should be a member of ${scratchProjectName}`)
      await removeHarborProjectMember(conn, scratchProjectId, member.id)
      assert.equal(await findHarborProjectMember(conn, scratchProjectId, username), null)
    },
  },
  {
    id: "members/unknown-user",
    capabilityId: "project-members",
    run: async ({ conn, scratchProjectId }) => {
      // An account the directory does not know must fail loudly and specifically: this is the
      // path behind HarborUnknownUserError, which the Gateway does not retry.
      await assert.rejects(
        applyHarborProjectMember(conn, scratchProjectId, `tessark-conf-nobody-${Date.now()}`, HARBOR_ROLE_DEVELOPER),
        // Specifically HarborUnknownUserError: the Gateway keys its "do not retry this" decision
        // on that type, so a generic failure here would be a different bug wearing the same coat.
        (error: unknown) => error instanceof HarborUnknownUserError,
      )
    },
  },
  {
    id: "catalog/list-repositories",
    capabilityId: "catalog-browse",
    run: async ({ conn, scratchProjectName }) => {
      const repositories = await listHarborRepositories(conn, scratchProjectName)
      assert.deepEqual(repositories, [], "a fresh project holds no repository")
    },
  },
  {
    id: "catalog/list-artifacts",
    capabilityId: "catalog-browse",
    run: async ({ conn }) => {
      // Reading a real artifact needs one to exist; the campaign does not push images, so this
      // borrows whatever the instance already holds and skips when it holds nothing.
      const projects = await listHarborProjects(conn)
      for (const project of projects.filter((entry) => entry.repoCount > 0)) {
        const [repository] = await listHarborRepositories(conn, project.name)
        if (!repository) continue
        const artifacts = await listHarborArtifacts(conn, project.name, repository.name)
        assert.ok(artifacts.length > 0, `${repository.name} reports repositories but no artifact`)
        assert.ok(artifacts.every((artifact) => artifact.digest.startsWith("sha256:")))
        return
      }
      throw new ScenarioUnavailable("no project on this instance holds an artifact to read")
    },
  },
  {
    id: "quota/read",
    capabilityId: "project-quota",
    run: async ({ conn, scratchProjectId }) => {
      const quota = await getHarborProjectQuota(conn, scratchProjectId)
      assert.ok(quota, "a project must carry a quota entry")
      assert.equal(typeof quota.usedBytes, "number")
    },
  },
  {
    id: "quota/set",
    capabilityId: "project-quota",
    run: async ({ conn, scratchProjectId }) => {
      const oneGigabyte = 1024 * 1024 * 1024
      // A quota has an ID of its own. It happens to equal the project's on a fresh Harbor, which
      // is how passing the project ID here went unnoticed until an instance where they differ
      // (2026-09-10: project 27, quota 23) answered 404.
      const before = await getHarborProjectQuota(conn, scratchProjectId)
      assert.ok(before, "Harbor creates one quota per project")
      await setHarborProjectQuota(conn, before.id, oneGigabyte)
      const quota = await getHarborProjectQuota(conn, scratchProjectId)
      assert.equal(quota?.hardBytes, oneGigabyte)
      await setHarborProjectQuota(conn, before.id, -1)
    },
  },
  {
    id: "retention/create",
    capabilityId: "retention-policy",
    run: async (context) => {
      const id = await createHarborRetentionPolicy(context.conn, context.scratchProjectId, 10, "**")
      assert.ok(id > 0, "Harbor must return the retention policy id in Location")
      retentionIds.set(context.scratchProjectId, id)
    },
  },
  {
    id: "retention/update",
    capabilityId: "retention-policy",
    run: async (context) => {
      const id = retentionIds.get(context.scratchProjectId)
      if (!id) throw new ScenarioUnavailable("retention/create did not run")
      await updateHarborRetentionPolicy(context.conn, id, context.scratchProjectId, 5, "v*")
    },
  },
  {
    id: "robot/create",
    capabilityId: "system-robot",
    run: async (context) => {
      const robot = await createHarborRobotAccount(context.conn, context.scratchProjectName, "tessark-conf-robot", {
        description: "Tessark conformance campaign",
        expiresInDays: 1,
      })
      assert.ok(robot.secret.length > 0, "a created robot must come with a secret")
      // Harbor prefixes the name it generates; assuming the short name is what exists is a
      // classic way to lose track of a robot.
      assert.ok(robot.name.includes("tessark-conf-robot"))
      robots.set(context.scratchProjectName, robot.id)
    },
  },
  {
    id: "robot/effective-permissions",
    capabilityId: "system-robot",
    run: async ({ conn, scratchProjectName }) => {
      const robot = await createHarborRobotAccount(conn, scratchProjectName, "tessark-conf-perms", {
        expiresInDays: 1,
        permissions: DEFAULT_ROBOT_PERMISSIONS,
      })
      try {
        assert.ok(robot.id > 0)
      } finally {
        await deleteHarborRobotAccount(conn, robot.id)
      }
    },
  },
  {
    id: "robot/delete",
    capabilityId: "system-robot",
    run: async ({ conn, scratchProjectName }) => {
      const id = robots.get(scratchProjectName)
      if (!id) throw new ScenarioUnavailable("robot/create did not run")
      await deleteHarborRobotAccount(conn, id)
      robots.delete(scratchProjectName)
    },
  },
  {
    id: "artifacts/delete-removes-all-tags",
    capabilityId: "artifact-delete",
    run: async (context) => {
      const image = await ensureScratchImage(context, DELETE_REPO)
      // The property the deletion dialog is built on: Harbor deletes the *artifact*, so every
      // tag on that digest goes with it. Naming them before asking for confirmation is only
      // honest if this is true.
      assert.deepEqual([...image.tags].sort(), ["a", "b"], "the fixture should carry two tags on one digest")
      await deleteHarborArtifact(context.conn, context.scratchProjectName, DELETE_REPO, image.digest)
      const remaining = await listHarborArtifacts(context.conn, context.scratchProjectName, DELETE_REPO)
      assert.equal(remaining.length, 0, "deleting one digest must take both of its tags")
      scratchImages.delete(DELETE_REPO)
    },
  },
  {
    id: "artifacts/delete-by-digest",
    capabilityId: "artifact-delete",
    run: async (context) => {
      const image = await ensureScratchImage(context, DELETE_REPO)
      await deleteHarborArtifact(context.conn, context.scratchProjectName, DELETE_REPO, image.digest)
      const remaining = await listHarborArtifacts(context.conn, context.scratchProjectName, DELETE_REPO)
      assert.equal(remaining.some((artifact) => artifact.digest === image.digest), false)
      scratchImages.delete(DELETE_REPO)
    },
  },
  {
    id: "scan/trigger",
    capabilityId: "vulnerability-scan",
    run: async (context) => {
      const image = await ensureScratchImage(context)
      await requestHarborScan(context.conn, image.repo, image.digest, "vulnerability")
      // Harbor answers 202 and works on its own schedule, so the assertion is that a report
      // eventually exists — not that the call returned quickly.
      await waitForScan(context, image.repo, image.digest, (detail) => detail?.vulnerabilities != null)
    },
  },
  {
    id: "scan/read-report",
    capabilityId: "vulnerability-scan",
    run: async (context) => {
      const image = await ensureScratchImage(context)
      const detail = await waitForScan(context, image.repo, image.digest, (entry) => entry?.vulnerabilities != null)
      const summary = detail.vulnerabilities!
      // summarizeScanOverview() takes the first scanner's report; what must hold is that the
      // counters are numbers we can render, not that any CVE was found.
      for (const level of ["critical", "high", "medium", "low"] as const) {
        assert.equal(typeof summary[level], "number", `${level} should be a number`)
      }
    },
  },
  {
    id: "sbom/read-format",
    capabilityId: "sbom-generation",
    run: async (context) => {
      const image = await ensureScratchImage(context)
      await requestHarborScan(context.conn, image.repo, image.digest, "sbom")
      const detail = await waitForScan(
        context,
        image.repo,
        image.digest,
        (entry) => entry?.supplyChain?.sbom === true,
      )
      // A multi-arch index reports Success and writes no sbom_digest — the SBOM exists per
      // platform, not for the index (harbor.ts). That is a property of the fixture, not a
      // Harbor failure, so it is a skip rather than a verdict.
      if (detail.platform === null && detail.kind === "image") {
        throw new ScenarioUnavailable("the fixture is a multi-arch index, which carries no SBOM of its own")
      }
      const sbom = await getHarborArtifactSbom(context.conn, image.repo, image.digest)
      assert.ok(sbom, "Harbor reported an SBOM but no document could be fetched")
      // harbor.ts records that Trivy under 2.15 emits SPDX, not the CycloneDX the docs imply.
      // Whichever it is, the point is that the format is *announced* and recognised rather than
      // falling back to the "json" catch-all, which would mean we are guessing.
      assert.notEqual(sbom.format, "json", `the SBOM document announced no format: ${sbom.format}`)
    },
  },
  {
    id: "signature/detect-absent",
    capabilityId: "cosign-signature",
    run: async (context) => {
      const image = await ensureScratchImage(context)
      const detail = await getHarborArtifactDetail(context.conn, image.repo, image.digest)
      const present = await listHarborArtifacts(context.conn, context.scratchProjectName, SCAN_REPO)
      assert.ok(
        detail,
        `${image.repo}@${image.digest.slice(0, 19)}… was not readable; the repository holds ` +
          `${present.length} artifact(s): ${present.map((entry) => entry.digest.slice(0, 19)).join(", ")}`,
      )
      // An unsigned artifact must read as unsigned rather than as unknown: the UI says "not
      // signed" here, and it is only allowed to if Harbor actually answered.
      assert.equal(detail.supplyChain?.signed, false)
      assert.equal(detail.supplyChain?.signatureCount, 0)
    },
  },
  {
    id: "signature/detect-present",
    capabilityId: "cosign-signature",
    run: async () => {
      // Signing needs cosign and a key; until the campaign can produce a signed artifact, the
      // capability stays inconclusive rather than being certified on its negative half alone.
      throw new ScenarioUnavailable("no signed artifact available — cosign is not installed on this host")
    },
  },
  {
    id: "replication/endpoint-upsert",
    capabilityId: "replication-endpoint",
    run: async (context) => {
      const peer = peerEndpointInput()
      const name = `tessark-conf-peer-${context.scratchProjectName.slice(-8)}`
      const input = { name, url: peer.url, username: peer.username, secret: peer.secret, insecure: true }
      const id = await createHarborRegistryEndpoint(context.conn, input)
      leftoverReplication.endpointId = id
      // replication.ts updates an existing endpoint instead of recreating it, because a second
      // POST answers 409 and would hand back the id of an object still carrying the old secret.
      const updated = await updateHarborRegistryEndpoint(context.conn, id, { ...input, secret: peer.secret })
      assert.equal(updated, true, "an existing endpoint must be updatable in place")
      assert.equal(await createHarborRegistryEndpoint(context.conn, input), id, "re-creating must adopt, not duplicate")
    },
  },
  {
    id: "replication/ping-from-source",
    capabilityId: "replication-endpoint",
    run: async (context) => {
      const id = leftoverReplication.endpointId
      if (!id) throw new ScenarioUnavailable("replication/endpoint-upsert did not run")
      // The Gateway reaching both Harbors says nothing about one reaching the other. A failure
      // here carries Harbor's own reason, which is what tells an operator whether the peer URL
      // is wrong or the network is.
      const reason = await pingHarborRegistryEndpoint(context.conn, id)
      assert.equal(reason, null, `the source Harbor could not reach the peer: ${reason}`)
    },
  },
  {
    id: "replication/policy-apply",
    capabilityId: "replication-policy",
    run: async (context) => {
      const endpointId = leftoverReplication.endpointId
      if (!endpointId) throw new ScenarioUnavailable("replication/endpoint-upsert did not run")
      // Scheduled far away rather than event_based: a campaign must not start moving images
      // onto the peer as a side effect. Six fields, which is what Harbor's own trigger takes.
      const policyId = await createHarborReplicationPolicy(context.conn, `tessark-conf-replicate-${endpointId}`, endpointId, {
        type: "scheduled",
        cron: "0 0 0 1 1 *",
      })
      leftoverReplication.policyId = policyId
      assert.ok(policyId > 0)
    },
  },
  {
    id: "replication/endpoint-in-use-refuses-delete",
    capabilityId: "replication-endpoint",
    run: async (context) => {
      const endpointId = leftoverReplication.endpointId
      if (!endpointId || !leftoverReplication.policyId) throw new ScenarioUnavailable("no endpoint and policy pair")
      // Why replication.ts deletes the policy first: Harbor refuses to drop an endpoint a policy
      // still references. Getting the order wrong leaves the policy armed and the mesh lying.
      await assert.rejects(deleteHarborRegistryEndpoint(context.conn, endpointId))
    },
  },
  {
    id: "replication/disable-before-delete",
    capabilityId: "replication-policy",
    run: async (context) => {
      const policyId = leftoverReplication.policyId
      if (!policyId) throw new ScenarioUnavailable("replication/policy-apply did not run")
      // Harbor answers 412 while an execution is not final, and a policy that survives deletion
      // must at least be inert. The disable is a read-modify-write: a partial PUT would wipe the
      // filters and the trigger.
      const before = await readReplicationPolicy(context.conn, policyId)
      assert.equal(before.enabled, true, "a fresh policy is enabled")

      await disableHarborReplicationPolicy(context.conn, policyId)
      const disabled = await readReplicationPolicy(context.conn, policyId)
      // Measured on 2.15.0: Harbor *omits* `enabled` from the response once it is false rather
      // than echoing it. A caller testing `enabled === false` would conclude the policy is still
      // armed and go on to delete it while it can still move images.
      assert.notEqual(disabled.enabled, true, "the policy should be switched off before it is removed")
      assert.equal(
        (disabled.trigger as { type?: string } | undefined)?.type,
        "scheduled",
        "the disable is a read-modify-write: a partial PUT would have wiped the trigger",
      )
      assert.deepEqual(
        disabled.filters,
        before.filters,
        "the disable must not drop the filters either — they decide what the policy would move",
      )
      await deleteHarborReplicationPolicy(context.conn, policyId)
      leftoverReplication.policyId = null
      if (leftoverReplication.endpointId) {
        await deleteHarborRegistryEndpoint(context.conn, leftoverReplication.endpointId)
        leftoverReplication.endpointId = null
      }
    },
  },
]

/** Resources handed between scenarios of the same capability, cleaned up by the runner. */
const retentionIds = new Map<number, number>()
const robots = new Map<string, number>()

export function leftoverRobots(): Map<string, number> {
  return robots
}
