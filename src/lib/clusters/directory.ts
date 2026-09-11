import {
  getHarborAuthConfig,
  HarborDirectoryError,
  importLdapUsers,
  listHarborUserGroups,
  registerHarborLdapGroup,
  searchHarborUsers,
  searchLdapGroups,
  searchLdapUsers,
  type HarborAuthConfig,
  type HarborUnknownUserReason,
} from "@/lib/registries/harbor"
import { errorMessage } from "./fanout"
import { loadClusterMembers, pickHealthyMember, type ClusterMember } from "./members"

// What a search of a cluster's directory can actually reach, before a field is offered that
// would never find anything (docs/plan-ldap-sso-local.md, lots 1–3).
//
// The Gateway never talks to LDAP itself (D3): a cluster's directory is whatever its Harbors are
// configured with, read through /api/v2.0/ldap/*. Two sources therefore exist and must never be
// confused in silence — the **directory** (every account, including people who never signed in
// to Harbor) and the accounts **Harbor already knows** (only those who did). The second is what
// the Gateway offered until now, and it is exactly the circular dead end: nobody can be granted a
// project until they appear, and they cannot appear without a project to sign in to.

/**
 * - `ldap-live` — the Harbor has LDAP settings, so the directory itself can be searched. Measured
 *   on 2.15: true whatever its auth_mode, db_auth and oidc_auth included (M1).
 * - `harbor-known` — only accounts this Harbor already holds can be listed.
 * - `unreachable` — no member answered; nothing can be said.
 */
export type DirectoryCapability = "ldap-live" | "harbor-known" | "unreachable"

/**
 * Whether a person found in the directory can be granted access before they ever signed in:
 * an LDAP-backed Harbor creates the account at grant time (`on-grant`), an OIDC-backed one only
 * at the person's first sign-in (`first-sign-in`), a database-backed one never by itself.
 */
export type DirectoryProvisioning = "on-grant" | "first-sign-in" | "local-accounts" | "unknown"

export type DirectoryCapabilityReason =
  | "no-member"
  | "no-reachable-member"
  | "configuration-unreadable"
  | "ldap-not-configured"

export interface DirectoryCapabilityView {
  capability: DirectoryCapability
  provisioning: DirectoryProvisioning
  reason: DirectoryCapabilityReason | null
  /** The member the answer comes from — the same one a search goes to. */
  registryId: string | null
  registryName: string | null
  authMode: string | null
  /** A sentence of ours explaining a degraded answer. Never carries a credential. */
  detail: string | null
}

export function provisioningFor(authMode: string | null): DirectoryProvisioning {
  switch (authMode) {
    case "ldap_auth":
      return "on-grant"
    case "oidc_auth":
      return "first-sign-in"
    case "db_auth":
      return "local-accounts"
    default:
      return "unknown"
  }
}

/** The capability a Harbor configuration grants. Pure, so the rule itself is testable. */
export function capabilityFromConfig(
  config: Pick<HarborAuthConfig, "authMode"> & { ldap: Pick<HarborAuthConfig["ldap"], "url"> }
): Pick<DirectoryCapabilityView, "capability" | "provisioning" | "reason" | "authMode"> {
  const live = config.ldap.url.trim() !== ""
  return {
    capability: live ? "ldap-live" : "harbor-known",
    provisioning: provisioningFor(config.authMode || null),
    reason: live ? null : "ldap-not-configured",
    authMode: config.authMode || null,
  }
}

function offline(reason: DirectoryCapabilityReason, detail: string | null = null): DirectoryCapabilityView {
  return {
    capability: "unreachable",
    provisioning: "unknown",
    reason,
    registryId: null,
    registryName: null,
    authMode: null,
    detail,
  }
}

/** Never throws: a member that does not answer is described, not raised. */
export async function describeMemberDirectory(member: ClusterMember): Promise<DirectoryCapabilityView> {
  const origin = { registryId: member.registryId, registryName: member.registryName }
  try {
    return { ...origin, ...capabilityFromConfig(await getHarborAuthConfig(member.conn)), detail: null }
  } catch (err) {
    // A Harbor that answers but will not show its configuration — credentials that are not a
    // Harbor administrator — can still be searched the way it always was. Saying which of the
    // two searches is running is the point; guessing "directory" here would be the silent
    // confusion this module exists to remove.
    if (err instanceof HarborDirectoryError && err.failure === "forbidden") {
      return {
        ...origin,
        capability: "harbor-known",
        provisioning: "unknown",
        reason: "configuration-unreadable",
        authMode: null,
        detail: err.message,
      }
    }
    return { ...offline("no-reachable-member", errorMessage(err)), ...origin }
  }
}

// The configuration of a Harbor does not move by the minute, and asking for it on every
// keystroke of a picker would double the round trips of a search. Per process, like the
// replication and system-robot locks: a second pod only pays one extra read.
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { view: DirectoryCapabilityView; expires: number }>()

export function forgetDirectoryCapability(clusterId?: string): void {
  if (clusterId) cache.delete(clusterId)
  else cache.clear()
}

export function rememberDirectoryCapability(clusterId: string, view: DirectoryCapabilityView): void {
  // An unreachable answer is never cached: a member coming back must be seen at once.
  if (view.capability === "unreachable") cache.delete(clusterId)
  else cache.set(clusterId, { view, expires: Date.now() + CACHE_TTL_MS })
}

/**
 * The member a directory search goes to, with what it can search. Null when no member answers.
 * The cached capability is only reused when it describes that very member: the healthy member
 * of a cluster can change between two calls, and so can what its Harbor is configured with.
 */
export async function openClusterDirectory(
  clusterId: string
): Promise<{ member: ClusterMember; capability: DirectoryCapabilityView } | null> {
  const member = await pickHealthyMember(clusterId)
  if (!member) return null

  const cached = cache.get(clusterId)
  if (cached && cached.expires > Date.now() && cached.view.registryId === member.registryId) {
    return { member, capability: cached.view }
  }
  const capability = await describeMemberDirectory(member)
  rememberDirectoryCapability(clusterId, capability)
  return { member, capability }
}

/** What a search of this cluster's directory can reach. Never throws. */
export async function resolveDirectoryCapability(clusterId: string): Promise<DirectoryCapabilityView> {
  try {
    if ((await loadClusterMembers(clusterId)).length === 0) return offline("no-member")
    const opened = await openClusterDirectory(clusterId)
    return opened?.capability ?? offline("no-reachable-member")
  } catch (err) {
    return offline("no-reachable-member", errorMessage(err))
  }
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export type DirectorySource = "directory" | "harbor"

export interface DirectoryUserHit {
  username: string
  /** Harbor's own ID, when this Harbor already holds the account. */
  userId: number | null
  realname: string | null
  email: string | null
  source: DirectorySource
  /**
   * False for a directory account that never signed in to Harbor. Grantable right away on an
   * LDAP-backed Harbor; on an OIDC-backed one, not before that person's first sign-in.
   */
  knownToHarbor: boolean
}

export interface DirectoryUserSearch {
  source: DirectorySource
  capability: DirectoryCapabilityView
  users: DirectoryUserHit[]
  truncated: boolean
  /** Set when the directory was expected to answer and did not; the list is then Harbor's only. */
  directoryError: string | null
}

function harborUserHit(user: { userId: number; username: string }): DirectoryUserHit {
  return {
    username: user.username,
    userId: user.userId,
    realname: null,
    email: null,
    source: "harbor",
    knownToHarbor: true,
  }
}

/**
 * Searches one member for accounts. On an `ldap-live` member the directory answers the exact
 * identifier and Harbor's own table the partial matches (its search is a substring one); both
 * are returned, each hit saying where it came from. An empty query returns nothing — a directory
 * may hold tens of thousands of accounts, and Harbor's LDAP search returns all of them.
 */
export async function searchDirectoryUsers(
  member: ClusterMember,
  capability: DirectoryCapabilityView,
  query: string,
  pageSize: number
): Promise<DirectoryUserSearch> {
  const q = query.trim()
  const live = capability.capability === "ldap-live"
  if (!q) {
    return { source: live ? "directory" : "harbor", capability, users: [], truncated: false, directoryError: null }
  }

  const known = await searchHarborUsers(member.conn, q, pageSize + 1)
  const knownOnly = (directoryError: string | null): DirectoryUserSearch => ({
    source: "harbor",
    capability,
    users: known.slice(0, pageSize).map(harborUserHit),
    truncated: known.length > pageSize,
    directoryError,
  })
  if (!live) return knownOnly(null)

  let directory
  try {
    directory = await searchLdapUsers(member.conn, q)
  } catch (err) {
    return knownOnly(errorMessage(err))
  }

  const knownByName = new Map(known.map((u) => [u.username.toLowerCase(), u]))
  const hits: DirectoryUserHit[] = []
  for (const entry of directory) {
    let match = knownByName.get(entry.username.toLowerCase())
    // Harbor's own search is case-sensitive, so an account it holds under another case would be
    // reported as never signed in. One exact follow-up settles it for the (rare) directory hit.
    if (!match) {
      const exact = await searchHarborUsers(member.conn, entry.username, 5)
      match = exact.find((u) => u.username.toLowerCase() === entry.username.toLowerCase())
    }
    hits.push({
      username: match?.username ?? entry.username,
      userId: match?.userId ?? null,
      realname: entry.realname,
      email: entry.email,
      source: "directory",
      knownToHarbor: Boolean(match),
    })
  }

  const seen = new Set(hits.map((hit) => hit.username.toLowerCase()))
  const all = [...hits, ...known.filter((u) => !seen.has(u.username.toLowerCase())).map(harborUserHit)]
  return {
    source: "directory",
    capability,
    users: all.slice(0, pageSize),
    truncated: all.length > pageSize,
    directoryError: null,
  }
}

export interface DirectoryGroupHit {
  /** Harbor's group ID; null for a directory group this Harbor has not registered yet. */
  id: number | null
  name: string
  /** Harbor's encoding: 1 = LDAP, 2 = HTTP, 3 = OIDC. */
  type: number | null
  /** The DN, when it was read from the directory. */
  dn: string | null
  source: DirectorySource
  /**
   * Whether granting this group can succeed. A group Harbor already holds always can; a
   * directory group it has not registered only on an LDAP-backed Harbor, which accepts a DN
   * (measured: db_auth and oidc_auth answer "not supported").
   */
  grantable: boolean
}

export interface DirectoryGroupSearch {
  source: DirectorySource
  capability: DirectoryCapabilityView
  groups: DirectoryGroupHit[]
  directoryError: string | null
}

/**
 * The groups a project may be granted. Harbor's registered groups are few and listed whole; a
 * directory group is looked up by its exact name, and offered even though Harbor has never seen
 * it — its DN comes from the directory, so nothing is named from memory.
 */
export async function searchDirectoryGroups(
  member: ClusterMember,
  capability: DirectoryCapabilityView,
  query: string
): Promise<DirectoryGroupSearch> {
  const known = await listHarborUserGroups(member.conn, query)
  const knownHits: DirectoryGroupHit[] = known.map((g) => ({
    id: g.id,
    name: g.name,
    type: g.type,
    dn: null,
    source: "harbor",
    grantable: true,
  }))
  const live = capability.capability === "ldap-live"
  const q = query.trim()
  if (!live || !q) {
    return { source: live ? "directory" : "harbor", capability, groups: knownHits, directoryError: null }
  }

  let directory
  try {
    directory = await searchLdapGroups(member.conn, { name: q })
  } catch (err) {
    return { source: "harbor", capability, groups: knownHits, directoryError: errorMessage(err) }
  }

  const knownNames = new Set(known.map((g) => g.name.toLowerCase()))
  const fromDirectory: DirectoryGroupHit[] = directory
    .filter((g) => !knownNames.has(g.name.toLowerCase()))
    .map((g) => ({
      id: null,
      name: g.name,
      type: 1,
      dn: g.dn,
      source: "directory",
      grantable: capability.provisioning === "on-grant",
    }))
  return { source: "directory", capability, groups: [...fromDirectory, ...knownHits], directoryError: null }
}

// ---------------------------------------------------------------------------------------------
// Grant-time recovery (lot 3)
// ---------------------------------------------------------------------------------------------

/**
 * Called when a member refused to grant `username` because it does not know the account. Asks
 * that very Harbor why, and imports the account when its directory has it.
 *
 * On 2.15 an LDAP-backed Harbor already creates the account while granting it, so the import is
 * a catch-up for versions or configurations where it does not — never a systematic extra round
 * trip on the nominal path. Its real value is the answer: after it, "unknown user" finally means
 * what it says, instead of "has not signed in yet".
 *
 * Returns "imported" when the grant is worth retrying, a reason otherwise, and null when this
 * Harbor could not be asked. A directory that fails to answer is rethrown so the grant is queued
 * and replayed, like any transient failure; a refusal of the credentials is not.
 */
export async function recoverUnknownUser(
  member: ClusterMember,
  username: string
): Promise<"imported" | HarborUnknownUserReason | null> {
  let config
  try {
    config = await getHarborAuthConfig(member.conn)
  } catch {
    return null
  }

  switch (config.authMode) {
    case "ldap_auth": {
      let outcome
      try {
        outcome = await importLdapUsers(member.conn, [username])
      } catch (err) {
        if (err instanceof HarborDirectoryError && err.failure === "forbidden") return null
        throw err
      }
      if (outcome.imported.length > 0) return "imported"
      return outcome.failed.some((f) => f.error === "unknown_user") ? "absent-from-directory" : null
    }
    case "oidc_auth":
      return "not-yet-signed-in"
    case "db_auth":
      return "no-local-account"
    default:
      return null
  }
}

/**
 * Registers `groupName` on this member from the DN its own directory returns for that exact
 * name. False when the member cannot take a directory group (not LDAP-backed, no such group, or
 * credentials not allowed to ask); rethrows a directory that fails to answer, so the grant is
 * queued rather than dropped.
 */
export async function registerDirectoryGroup(member: ClusterMember, groupName: string): Promise<boolean> {
  try {
    const config = await getHarborAuthConfig(member.conn)
    if (config.authMode !== "ldap_auth" || !config.ldap.url) return false

    const groups = await searchLdapGroups(member.conn, { name: groupName })
    const match = groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase())
    if (!match) return false

    await registerHarborLdapGroup(member.conn, match.name, match.dn)
    return true
  } catch (err) {
    if (err instanceof HarborDirectoryError && err.failure === "forbidden") return false
    throw err
  }
}
