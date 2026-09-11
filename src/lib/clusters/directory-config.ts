import { createHash } from "node:crypto"

import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import {
  countHarborUsers,
  getHarborAuthConfig,
  pingHarborLdap,
  putHarborLdapConfig,
  setHarborAuthMode,
  type HarborLdapCandidate,
} from "@/lib/registries/harbor"
import { forgetDirectoryCapability } from "./directory"
import { errorMessage } from "./fanout"
import { loadClusterMembers, loadMember } from "./members"

// Writing the LDAP configuration of a cluster's Harbors (docs/plan-ldap-sso-local.md, lot 7) —
// so that the same directory stops being typed by hand into N Harbor admin screens.
//
// Everything else the Gateway writes to Harbor is replayable; this is not, on purpose (D11):
//
//  - **Opt-in per cluster, SUPERADMIN, explicit gesture.** Never queued, never replayed by the
//    reconciler. A replay would overwrite a correction an operator made by hand in the meantime
//    and lock their users out again without anybody asking for it.
//  - **Each Harbor tests the settings before they are written** (POST /ldap/ping), without
//    exception. A Harbor whose test fails is not written at all.
//  - **A fingerprint, secret included.** Harbor never returns the bind password, so comparing
//    what is there is impossible; comparing with what the Gateway last wrote is not. Identical
//    means no network call — the ReplicationLink.appliedFingerprint pattern. `force` is the
//    "verify and repair" path, for a Harbor edited by hand.
//  - **auth_mode only on a blank Harbor.** Harbor refuses it as soon as one non-admin account
//    exists (measured, M4); the Gateway checks first so the answer is a sentence, not a 400.
//
// The blast radius is wider than any other write: a wrong base DN on an LDAP-backed Harbor locks
// out every human user of it. Its local `admin` still signs in whatever the mode.

export class DirectoryConfigDisabledError extends Error {
  constructor() {
    super("Writing the directory configuration is not enabled for this cluster.")
    this.name = "DirectoryConfigDisabledError"
  }
}

export class DirectoryConfigIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DirectoryConfigIncompleteError"
  }
}

export interface DirectoryConfigInput {
  enabled: boolean
  url: string
  searchDn: string
  /** Omitted keeps the stored password; an empty string clears it. */
  searchPassword?: string
  baseDn: string
  filter: string
  uid: string
  scope: number
  verifyCert: boolean
  groupBaseDn: string
  groupSearchFilter: string
  groupAttributeName: string
  groupMembershipAttribute: string
  groupSearchScope: number
}

export interface PublicDirectoryConfig {
  enabled: boolean
  url: string
  searchDn: string
  /** Whether a password is stored — the password itself never leaves the server. */
  hasSearchPassword: boolean
  baseDn: string
  filter: string
  uid: string
  scope: number
  verifyCert: boolean
  groupBaseDn: string
  groupSearchFilter: string
  groupAttributeName: string
  groupMembershipAttribute: string
  groupSearchScope: number
  updatedAt: string
}

export interface DirectoryConfigMemberState {
  registryId: string
  registryName: string
  appliedAt: string | null
  /** "in-sync" only when the last write carried exactly the stored settings, password included. */
  state: "in-sync" | "differs" | "never-applied"
}

type ConfigRow = NonNullable<Awaited<ReturnType<typeof prisma.clusterDirectoryConfig.findUnique>>>

/**
 * SHA-256 over the settings in a fixed order — written out by hand rather than taken from object
 * key order, so that a refactor reordering a type does not look like a change on every Harbor.
 * The password is part of it: a rotation is exactly the drift that must be detected.
 */
export function ldapFingerprint(candidate: HarborLdapCandidate): string {
  const parts = [
    candidate.url,
    candidate.searchDn,
    candidate.searchPassword,
    candidate.baseDn,
    candidate.filter,
    candidate.uid,
    String(candidate.scope),
    String(candidate.verifyCert),
    candidate.groupBaseDn,
    candidate.groupSearchFilter,
    candidate.groupAttributeName,
    candidate.groupMembershipAttribute,
    String(candidate.groupSearchScope),
  ]
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

function toCandidate(row: ConfigRow): HarborLdapCandidate | null {
  if (!row.encryptedSearchPassword) return null
  return {
    url: row.url,
    searchDn: row.searchDn,
    searchPassword: decryptSecret(row.encryptedSearchPassword),
    baseDn: row.baseDn,
    filter: row.filter,
    uid: row.uid,
    scope: row.scope,
    verifyCert: row.verifyCert,
    groupBaseDn: row.groupBaseDn,
    groupSearchFilter: row.groupSearchFilter,
    groupAttributeName: row.groupAttributeName,
    groupMembershipAttribute: row.groupMembershipAttribute,
    groupSearchScope: row.groupSearchScope,
  }
}

function toPublic(row: ConfigRow): PublicDirectoryConfig {
  return {
    enabled: row.enabled,
    url: row.url,
    searchDn: row.searchDn,
    hasSearchPassword: Boolean(row.encryptedSearchPassword),
    baseDn: row.baseDn,
    filter: row.filter,
    uid: row.uid,
    scope: row.scope,
    verifyCert: row.verifyCert,
    groupBaseDn: row.groupBaseDn,
    groupSearchFilter: row.groupSearchFilter,
    groupAttributeName: row.groupAttributeName,
    groupMembershipAttribute: row.groupMembershipAttribute,
    groupSearchScope: row.groupSearchScope,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getDirectoryConfig(
  clusterId: string
): Promise<{ config: PublicDirectoryConfig | null; members: DirectoryConfigMemberState[] }> {
  const [row, registries] = await Promise.all([
    prisma.clusterDirectoryConfig.findUnique({ where: { clusterId } }),
    prisma.registry.findMany({
      where: { clusterId, role: "MANAGED" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, ldapAppliedFingerprint: true, ldapAppliedAt: true },
    }),
  ])
  const candidate = row ? toCandidate(row) : null
  const desired = candidate ? ldapFingerprint(candidate) : null

  return {
    config: row ? toPublic(row) : null,
    members: registries.map((registry) => ({
      registryId: registry.id,
      registryName: registry.name,
      appliedAt: registry.ldapAppliedAt?.toISOString() ?? null,
      state: !registry.ldapAppliedFingerprint
        ? "never-applied"
        : registry.ldapAppliedFingerprint === desired
          ? "in-sync"
          : "differs",
    })),
  }
}

/** Stores the desired settings. Writes nothing to any Harbor — that is applyClusterDirectoryConfig. */
export async function saveDirectoryConfig(
  clusterId: string,
  input: DirectoryConfigInput
): Promise<PublicDirectoryConfig> {
  const existing = await prisma.clusterDirectoryConfig.findUnique({ where: { clusterId } })
  const encryptedSearchPassword =
    input.searchPassword === undefined
      ? existing?.encryptedSearchPassword ?? null
      : input.searchPassword === ""
        ? null
        : encryptSecret(input.searchPassword)

  const data = {
    enabled: input.enabled,
    url: input.url,
    searchDn: input.searchDn,
    encryptedSearchPassword,
    baseDn: input.baseDn,
    filter: input.filter,
    uid: input.uid,
    scope: input.scope,
    verifyCert: input.verifyCert,
    groupBaseDn: input.groupBaseDn,
    groupSearchFilter: input.groupSearchFilter,
    groupAttributeName: input.groupAttributeName,
    groupMembershipAttribute: input.groupMembershipAttribute,
    groupSearchScope: input.groupSearchScope,
  }
  const row = await prisma.clusterDirectoryConfig.upsert({
    where: { clusterId },
    create: { clusterId, ...data },
    update: data,
  })
  logger.info("Saved a cluster directory configuration", { clusterId, enabled: row.enabled })
  return toPublic(row)
}

/** Forgets the stored settings. Nothing is changed on the Harbors: they keep what they carry. */
export async function deleteDirectoryConfig(clusterId: string): Promise<void> {
  await prisma.clusterDirectoryConfig.deleteMany({ where: { clusterId } })
}

export type AuthModeOutcome = "not-requested" | "already" | "switched" | "locked"

export type LdapApplyOutcome = { registryId: string; registryName: string } & (
  | { status: "unchanged" }
  | { status: "applied"; written: boolean; authMode: AuthModeOutcome }
  | { status: "ping-failed"; message: string | null }
  | { status: "failed"; error: string }
)

/**
 * Writes `candidate` onto one Harbor, if its fingerprint differs from the last write (or `force`),
 * and only once that Harbor has confirmed it can bind with it.
 */
export async function applyLdapConfig(
  registryId: string,
  candidate: HarborLdapCandidate,
  opts: { force?: boolean; setAuthMode?: boolean } = {}
): Promise<LdapApplyOutcome> {
  const [member, registry] = await Promise.all([
    loadMember(registryId),
    prisma.registry.findUnique({ where: { id: registryId }, select: { ldapAppliedFingerprint: true } }),
  ])
  if (!member || !registry) throw new Error(`Registry ${registryId} not found`)
  const origin = { registryId, registryName: member.registryName }

  const fingerprint = ldapFingerprint(candidate)
  const changed = registry.ldapAppliedFingerprint !== fingerprint
  if (!changed && !opts.force && !opts.setAuthMode) return { ...origin, status: "unchanged" }

  try {
    // Without exception, even under `force`: a Harbor that cannot bind with these settings is
    // exactly the Harbor this write would lock its users out of.
    const ping = await pingHarborLdap(member.conn, candidate)
    if (!ping.success) {
      logger.warn("LDAP configuration not written: the Harbor's own test failed", {
        registryId,
        message: ping.message,
      })
      return { ...origin, status: "ping-failed", message: ping.message }
    }

    const written = changed || Boolean(opts.force)
    if (written) {
      await putHarborLdapConfig(member.conn, candidate)
      await prisma.registry.update({
        where: { id: registryId },
        data: { ldapAppliedFingerprint: fingerprint, ldapAppliedAt: new Date() },
      })
      logger.info("Wrote the LDAP configuration of a Harbor", { registryId })
    }

    let authMode: AuthModeOutcome = "not-requested"
    if (opts.setAuthMode) {
      const current = await getHarborAuthConfig(member.conn)
      if (current.authMode === "ldap_auth") {
        authMode = "already"
      } else if ((await countHarborUsers(member.conn)) > 0) {
        authMode = "locked"
      } else {
        await setHarborAuthMode(member.conn, "ldap_auth")
        authMode = "switched"
        logger.info("Switched a blank Harbor to LDAP sign-in", { registryId })
      }
    }

    return { ...origin, status: "applied", written, authMode }
  } catch (err) {
    logger.warn("Writing the LDAP configuration of a Harbor failed", { registryId, error: errorMessage(err) })
    return { ...origin, status: "failed", error: errorMessage(err) }
  }
}

/**
 * Applies the stored settings to every managed member of the cluster, one Harbor after the other:
 * a mistake that locks people out should be found on the first Harbor, not on all of them at once.
 */
export async function applyClusterDirectoryConfig(
  clusterId: string,
  opts: { force?: boolean; setAuthMode?: boolean } = {}
): Promise<LdapApplyOutcome[]> {
  const row = await prisma.clusterDirectoryConfig.findUnique({ where: { clusterId } })
  if (!row?.enabled) throw new DirectoryConfigDisabledError()
  const candidate = toCandidate(row)
  if (!candidate) {
    throw new DirectoryConfigIncompleteError("A bind password is required before the settings can be written.")
  }

  const outcomes: LdapApplyOutcome[] = []
  for (const member of await loadClusterMembers(clusterId)) {
    outcomes.push(await applyLdapConfig(member.registryId, candidate, opts))
  }
  forgetDirectoryCapability(clusterId)
  return outcomes
}
