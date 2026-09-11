import {
  getHarborAuthConfig,
  HarborDirectoryError,
  searchLdapUsers,
  type HarborAuthConfig,
} from "@/lib/registries/harbor"
import {
  capabilityFromConfig,
  rememberDirectoryCapability,
  type DirectoryCapabilityView,
} from "./directory"
import { errorMessage } from "./fanout"
import { loadClusterMembers, type ClusterMember } from "./members"

// The read-only counterpart to directory-config.ts, kept apart the same way replication-view.ts
// is kept apart from replication.ts: that file writes a directory configuration, this one says
// what every member of the cluster is actually configured with, and whether they agree.
//
// Nobody can look at this by hand: the settings live in N Harbor admin screens, and a member
// configured on a different base DN than its peers silently hides people from one Harbor and not
// the other. Nothing here writes anything (docs/plan-ldap-sso-local.md, lot 4).

/**
 * The uid a member's directory is asked for to learn whether it answers at all. /ldap/ping cannot
 * serve here — it never reuses the stored bind password (measured) — while a search runs the
 * stored settings end to end and reports a broken bind, server or base DN as a 500.
 */
export const DIRECTORY_PROBE_UID = "tessark-directory-probe"

/** The settings compared across members — the bind password excepted, which Harbor never returns. */
export interface DirectoryComparedSettings {
  url: string
  searchDn: string
  baseDn: string
  filter: string
  uid: string
  scope: number | null
  verifyCert: boolean | null
  groupBaseDn: string
  groupSearchFilter: string
  groupAttributeName: string
  groupMembershipAttribute: string
}

export type DirectoryMemberStatus = "answered" | "unreachable" | "forbidden"

export interface DirectoryMemberView {
  registryId: string
  registryName: string
  /** Whether its configuration could be read — never "consistent" by default. */
  status: DirectoryMemberStatus
  error: string | null
  authMode: string | null
  ldapConfigured: boolean
  settings: DirectoryComparedSettings | null
  /** Whether the stored directory settings work; null when there are none to try. */
  directoryAnswered: boolean | null
  directoryError: string | null
}

export type DirectoryField = "authMode" | keyof DirectoryComparedSettings

export interface DirectoryDrift {
  field: DirectoryField
  /** "info" for differences that can be legitimate, such as two replicas of one directory. */
  severity: "warning" | "info"
  values: Array<{ value: string; registries: string[] }>
}

export type DirectoryFindingKind =
  | "unreachable"
  | "forbidden"
  | "directory-error"
  | "verify-cert-off"
  | "plaintext"
  | "ldap-missing"

export interface DirectoryFinding {
  kind: DirectoryFindingKind
  registryName: string
  detail: string | null
}

export type DirectoryVerdict = "consistent" | "attention" | "incomplete" | "no-directory"

export interface DirectoryClusterView {
  clusterId: string
  members: DirectoryMemberView[]
  drifts: DirectoryDrift[]
  findings: DirectoryFinding[]
  verdict: DirectoryVerdict
  /** What a search reaches — derived from the first member that answered, as a search picks it. */
  capability: DirectoryCapabilityView | null
  /**
   * Always false: `ldap_search_password` is write-only in Harbor's API, so two members bound with
   * different passwords look identical here. Carried as data so the UI has to say it.
   */
  passwordComparable: false
}

function settingsOf(config: HarborAuthConfig): DirectoryComparedSettings {
  const { url, searchDn, baseDn, filter, uid, scope, verifyCert, groupBaseDn, groupSearchFilter, groupAttributeName, groupMembershipAttribute } = config.ldap
  return { url, searchDn, baseDn, filter, uid, scope, verifyCert, groupBaseDn, groupSearchFilter, groupAttributeName, groupMembershipAttribute }
}

export async function readMemberDirectory(member: ClusterMember): Promise<DirectoryMemberView> {
  const base = { registryId: member.registryId, registryName: member.registryName }
  let config: HarborAuthConfig
  try {
    config = await getHarborAuthConfig(member.conn)
  } catch (err) {
    const forbidden = err instanceof HarborDirectoryError && err.failure === "forbidden"
    return {
      ...base,
      status: forbidden ? "forbidden" : "unreachable",
      error: errorMessage(err),
      authMode: null,
      ldapConfigured: false,
      settings: null,
      directoryAnswered: null,
      directoryError: null,
    }
  }

  const ldapConfigured = config.ldap.url.trim() !== ""
  let directoryAnswered: boolean | null = null
  let directoryError: string | null = null
  if (ldapConfigured) {
    try {
      await searchLdapUsers(member.conn, DIRECTORY_PROBE_UID)
      directoryAnswered = true
    } catch (err) {
      directoryAnswered = false
      directoryError = errorMessage(err)
    }
  }

  return {
    ...base,
    status: "answered",
    error: null,
    authMode: config.authMode || null,
    ldapConfigured,
    settings: ldapConfigured ? settingsOf(config) : null,
    directoryAnswered,
    directoryError,
  }
}

// Distinguished names and attribute names are case-insensitive in LDAP, and "ou=a, dc=b" is the
// same DN as "ou=a,dc=b". Comparing raw strings would report differences that are not.
const DN_FIELDS = new Set<DirectoryField>(["searchDn", "baseDn", "groupBaseDn"])
const CASELESS_FIELDS = new Set<DirectoryField>(["uid", "groupAttributeName", "groupMembershipAttribute"])

function comparable(field: DirectoryField, value: string): string {
  const trimmed = value.trim()
  if (DN_FIELDS.has(field)) return trimmed.toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s*=\s*/g, "=")
  if (CASELESS_FIELDS.has(field) || field === "url") return trimmed.toLowerCase().replace(/\/+$/, "")
  return trimmed
}

function display(value: string | number | boolean | null): string {
  return value === null ? "" : String(value)
}

const COMPARED_FIELDS: Array<keyof DirectoryComparedSettings> = [
  "url",
  "searchDn",
  "baseDn",
  "filter",
  "uid",
  "scope",
  "verifyCert",
  "groupBaseDn",
  "groupSearchFilter",
  "groupAttributeName",
  "groupMembershipAttribute",
]

function driftOf(
  field: DirectoryField,
  entries: Array<{ registryName: string; value: string }>
): DirectoryDrift | null {
  const groups = new Map<string, { value: string; registries: string[] }>()
  for (const entry of entries) {
    const key = comparable(field, entry.value)
    const group = groups.get(key) ?? { value: entry.value, registries: [] }
    group.registries.push(entry.registryName)
    groups.set(key, group)
  }
  if (groups.size < 2) return null
  // Two servers may be replicas of one directory; everything else defines *which* accounts a
  // member can see, and a difference there hides people on one Harbor and not on its peers.
  return { field, severity: field === "url" ? "info" : "warning", values: [...groups.values()] }
}

/** Pure: the comparison itself, testable without a Harbor. */
export function compareDirectoryMembers(members: DirectoryMemberView[]): Pick<
  DirectoryClusterView,
  "drifts" | "findings" | "verdict"
> {
  const findings: DirectoryFinding[] = []
  const answered = members.filter((m) => m.status === "answered")

  for (const member of members) {
    if (member.status === "unreachable") {
      findings.push({ kind: "unreachable", registryName: member.registryName, detail: member.error })
    } else if (member.status === "forbidden") {
      findings.push({ kind: "forbidden", registryName: member.registryName, detail: member.error })
    }
  }

  const drifts: DirectoryDrift[] = []
  const authModes = driftOf(
    "authMode",
    answered.map((m) => ({ registryName: m.registryName, value: m.authMode ?? "" }))
  )
  if (authModes) drifts.push(authModes)

  const configured = answered.filter((m) => m.ldapConfigured && m.settings)
  if (configured.length > 0) {
    for (const member of answered) {
      if (!member.ldapConfigured) {
        findings.push({ kind: "ldap-missing", registryName: member.registryName, detail: null })
      }
    }
  }
  for (const member of configured) {
    if (member.directoryAnswered === false) {
      findings.push({ kind: "directory-error", registryName: member.registryName, detail: member.directoryError })
    }
    if (member.settings!.verifyCert === false) {
      findings.push({ kind: "verify-cert-off", registryName: member.registryName, detail: null })
    }
    if (member.settings!.url.trim().toLowerCase().startsWith("ldap://")) {
      findings.push({ kind: "plaintext", registryName: member.registryName, detail: null })
    }
  }

  for (const field of COMPARED_FIELDS) {
    const drift = driftOf(
      field,
      configured.map((m) => ({ registryName: m.registryName, value: display(m.settings![field]) }))
    )
    if (drift) drifts.push(drift)
  }

  const needsAttention =
    drifts.some((d) => d.severity === "warning") ||
    findings.some((f) => f.kind !== "unreachable" && f.kind !== "forbidden")
  const incomplete = answered.length < members.length || members.length === 0

  let verdict: DirectoryVerdict
  if (needsAttention) verdict = "attention"
  else if (incomplete) verdict = "incomplete"
  else if (configured.length === 0) verdict = "no-directory"
  else verdict = "consistent"

  return { drifts, findings, verdict }
}

/** Reads every member of the cluster and compares them. Null for a cluster with no member. */
export async function getClusterDirectoryView(clusterId: string): Promise<DirectoryClusterView | null> {
  const members = await loadClusterMembers(clusterId)
  if (members.length === 0) return null

  const views = await Promise.all(members.map((member) => readMemberDirectory(member)))
  const { drifts, findings, verdict } = compareDirectoryMembers(views)

  // Members come sorted by name, the order a search tries them in, so the first one that answered
  // is the one a search would reach — its capability is what the page should announce.
  const first = views.find((view) => view.status !== "unreachable") ?? null
  let capability: DirectoryCapabilityView | null = null
  if (first) {
    const origin = { registryId: first.registryId, registryName: first.registryName }
    capability =
      first.status === "forbidden"
        ? { ...origin, capability: "harbor-known", provisioning: "unknown", reason: "configuration-unreadable", authMode: null, detail: first.error }
        : {
            ...origin,
            ...capabilityFromConfig({ authMode: first.authMode ?? "", ldap: { url: first.settings?.url ?? "" } }),
            detail: null,
          }
    rememberDirectoryCapability(clusterId, capability)
  }

  return { clusterId, members: views, drifts, findings, verdict, capability, passwordComparable: false }
}
