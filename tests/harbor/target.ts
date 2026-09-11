/**
 * The Harbor a conformance campaign runs against.
 *
 * Never a default, never a guess: an unconfigured run does nothing and records nothing, because a
 * campaign that silently pointed somewhere unintended would put a signature on evidence nobody
 * asked for. Configure with:
 *
 *   HARBOR_CONFORMANCE_URL=http://localhost:1998 \
 *   HARBOR_CONFORMANCE_USERNAME=admin HARBOR_CONFORMANCE_PASSWORD=… npm run test:harbor
 */
import type { RegistryConnection } from "../../src/lib/registries/types"

/**
 * A directory the LDAP scenarios may use — optional, since a Harbor under test rarely has one.
 * Without it those scenarios are skipped, never failed:
 *
 *   HARBOR_CONFORMANCE_LDAP_URL=ldap://dc.example:389 HARBOR_CONFORMANCE_LDAP_BIND_DN=… \
 *   HARBOR_CONFORMANCE_LDAP_BIND_PASSWORD=… HARBOR_CONFORMANCE_LDAP_BASE_DN=ou=people,… \
 *   HARBOR_CONFORMANCE_LDAP_KNOWN_UID=alice HARBOR_CONFORMANCE_LDAP_GROUP=team-app
 *
 * HARBOR_CONFORMANCE_LDAP_WRITE=true additionally lets a scenario write these settings onto the
 * target's own configuration — the one thing a campaign cannot undo, since Harbor never returns
 * the password it replaces. Off unless said.
 */
export interface LdapFixture {
  url: string
  searchDn: string
  password: string
  baseDn: string
  uid: string
  knownUid: string
  groupName: string | null
  groupBaseDn: string
  allowWrite: boolean
}

export interface ConformanceTarget {
  conn: RegistryConnection
  /** Free-form label recorded with the run, so a result can be traced back to an instance. */
  label: string
  ldap: LdapFixture | null
}

export function resolveLdapFixture(): LdapFixture | null {
  /* eslint-disable no-restricted-syntax -- harness, not application code (see resolveTarget) */
  const env = process.env
  if (!env.HARBOR_CONFORMANCE_LDAP_URL || !env.HARBOR_CONFORMANCE_LDAP_KNOWN_UID) return null
  return {
    url: env.HARBOR_CONFORMANCE_LDAP_URL,
    searchDn: env.HARBOR_CONFORMANCE_LDAP_BIND_DN ?? "",
    password: env.HARBOR_CONFORMANCE_LDAP_BIND_PASSWORD ?? "",
    baseDn: env.HARBOR_CONFORMANCE_LDAP_BASE_DN ?? "",
    uid: env.HARBOR_CONFORMANCE_LDAP_UID ?? "uid",
    knownUid: env.HARBOR_CONFORMANCE_LDAP_KNOWN_UID,
    groupName: env.HARBOR_CONFORMANCE_LDAP_GROUP ?? null,
    groupBaseDn: env.HARBOR_CONFORMANCE_LDAP_GROUP_BASE_DN ?? "",
    allowWrite: env.HARBOR_CONFORMANCE_LDAP_WRITE === "true",
  }
  /* eslint-enable no-restricted-syntax */
}

export function resolveTarget(): ConformanceTarget | null {
  /* eslint-disable no-restricted-syntax -- The conformance harness is not application code: it
     takes its target from the operator's shell, and must never read the app's own registry rows. */
  const baseUrl = process.env.HARBOR_CONFORMANCE_URL
  if (!baseUrl) return null
  const username = process.env.HARBOR_CONFORMANCE_USERNAME ?? null
  const secret = process.env.HARBOR_CONFORMANCE_PASSWORD ?? null
  const insecureTLS = process.env.HARBOR_CONFORMANCE_INSECURE === "true"
  /* eslint-enable no-restricted-syntax */

  return {
    label: baseUrl,
    ldap: resolveLdapFixture(),
    conn: {
      id: "",
      name: "conformance target",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      authType: username ? "basic" : "none",
      username,
      secret,
      insecureTLS,
    },
  }
}
