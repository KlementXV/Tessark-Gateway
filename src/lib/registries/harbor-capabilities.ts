/**
 * What the Gateway can ask of a given Harbor, and on what evidence.
 *
 * Three questions are kept apart on purpose (docs/plan-harbor-compatibility.md §1), because
 * conflating them is how a compatibility matrix starts lying:
 *
 *  - **availability** — does the function exist in this Harbor version at all?
 *  - **support policy** — do we commit to it? Declared separately, per Gateway release.
 *  - **proof** — what did we actually run, on which exact version and which Gateway code?
 *
 * A version outside the support window may hold a perfectly working function; a version inside
 * it is not thereby verified. Only `evaluateCapability()` combines the three, and it is the
 * single evaluator behind the UI, the generated doc and the server-side guards.
 *
 * This module is pure: no fs, no network, no Prisma. It is imported by request-time server code
 * and, from lot 4 on, by client components.
 */

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export interface HarborVersion {
  major: number
  minor: number
  patch: number
}

/**
 * Parses what Harbor reports in `/systeminfo`.
 *
 * Harbor answers "v2.15.2" on a release, and the field is absent for an anonymous caller (see
 * getHarborVersion). Pre-release suffixes ("v2.16.0-rc1") are kept as their base version: an rc
 * is not the release, but it is far closer to it than to "unknown", and treating it as unreadable
 * would silently disable functions on a test instance. A build without a parsable version answers
 * null, which every caller must treat as "cannot tell", never as "old".
 */
export function parseHarborVersion(raw: string | null | undefined): HarborVersion | null {
  if (!raw) return null
  const match = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

/** Negative when `a` is older, 0 when equal, positive when newer. Patch included. */
export function compareVersions(a: HarborVersion, b: HarborVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function formatVersion(version: HarborVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/** "2.15" — the granularity at which upstream ships features and at which we publish rows. */
export function minorOf(version: HarborVersion): string {
  return `${version.major}.${version.minor}`
}

/**
 * A comparison against a bound written as "2.12", ">=2.12", "<2.12", ">2.14.1", "<=2.13".
 *
 * A bare version means "exactly this version, patch included" when it carries a patch, and
 * "anywhere in this minor" when it does not — "2.14" covers 2.14.0 through 2.14.99, which is what
 * a version-specific regression note almost always means.
 */
export function versionMatches(version: HarborVersion, range: string): boolean {
  const match = /^\s*(>=|<=|>|<)?\s*v?(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(range)
  if (!match) throw new Error(`Unparsable Harbor version range: ${range}`)
  const [, operator, major, minor, patch] = match
  const bound: HarborVersion = { major: Number(major), minor: Number(minor), patch: Number(patch ?? 0) }
  const comparison = compareVersions(version, bound)

  switch (operator) {
    case ">=":
      return comparison >= 0
    case ">":
      return comparison > 0
    case "<=":
      return comparison <= 0
    case "<":
      return comparison < 0
    default:
      return patch === undefined
        ? version.major === bound.major && version.minor === bound.minor
        : comparison === 0
  }
}

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

/** How the server behaves when a capability is not available, or cannot be established. */
export type HarborFallback =
  /** Leave the unsupported field out of the request — the rest of the call still lands. */
  | "omit-field"
  /** Refuse the operation with a message naming the version required and the version seen. */
  | "deny-operation"
  /** Go ahead, and say in the UI that this was never verified here. */
  | "allow-with-warning"

/** How much the `since` bound is worth. Printed as-is in the matrix, never smoothed over. */
export type BoundConfidence =
  /** A test of ours established it on real instances, both sides of the bound. */
  | "tested"
  /** Upstream documentation or spec says so; nobody has run it. */
  | "declared"
  /** Sources disagree — see `availabilityEvidence`. The bound in use is the conservative one. */
  | "disputed"

/**
 * The capability names, as a closed set.
 *
 * A union rather than `string` so the i18n catalogue can be checked against it at compile time:
 * every capability needs a name and a degradation in both catalogues, and a typo in an id would
 * otherwise surface as a raw key on the page rather than as a build error.
 */
export type HarborCapabilityId =
  | "harbor-identity"
  | "project-lifecycle"
  | "project-members"
  | "directory-identity"
  | "ldap-directory"
  | "ldap-config-write"
  | "catalog-browse"
  | "artifact-delete"
  | "vulnerability-scan"
  | "sbom-generation"
  | "cosign-signature"
  | "system-robot"
  | "retention-policy"
  | "project-quota"
  | "replication-endpoint"
  | "replication-policy"

export interface HarborCapability {
  id: HarborCapabilityId
  /** i18n key under `harborCompatibility.capabilities` for the human name. */
  nameKey: HarborCapabilityId
  /** Lowest version where the capability exists. Null means genuinely undetermined. */
  since: string | null
  sinceConfidence: BoundConfidence
  /** Version that dropped it, if any (Notary v1 in 2.11 is the shape of this). */
  removedIn?: string
  /** Where the bounds come from, one line each. Read by humans, printed in the matrix. */
  availabilityEvidence: string[]
  /** Version-specific overrides, evaluated before the general bounds. */
  exceptions: Array<{ range: string; available: boolean; reasonKey: string }>
  /** Harbor operations this capability needs, as "METHOD /path" below /api/v2.0. */
  operations: string[]
  /** Conformance tests that must all pass before this may read `verified`. */
  requiredTests: string[]
  /** i18n key for what the user loses when it is unavailable. */
  degradationKey: HarborCapabilityId
  fallback: HarborFallback
}

/**
 * Every operation in `tools/harbor-surface.ts` output must be claimed by at least one capability
 * here — that check is the point of the tool, and it fails the build when a new Harbor call
 * appears with nothing to answer for it. Operations may be claimed twice: `PUT /projects/{}`
 * carries both the project settings and the SBOM switch, which have different bounds and
 * different degradations.
 */
export const HARBOR_CAPABILITIES: readonly HarborCapability[] = Object.freeze([
  {
    id: "harbor-identity",
    nameKey: "harbor-identity",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "code: harborPing() treats /api/v2.0/ping as present on every Harbor 2.x",
      "spec: /ping and /systeminfo are in every 2.x swagger inspected (2.10.0, 2.11.0, 2.15.0)",
    ],
    exceptions: [],
    operations: ["GET /ping", "GET /systeminfo"],
    requiredTests: ["identity/ping", "identity/version-read"],
    degradationKey: "harbor-identity",
    fallback: "deny-operation",
  },
  {
    id: "project-lifecycle",
    nameKey: "project-lifecycle",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: ["spec: /projects CRUD present in 2.10.0 and unchanged through 2.15.0"],
    exceptions: [],
    operations: [
      "GET /projects",
      "POST /projects",
      "GET /projects/{}",
      "PUT /projects/{}",
      "DELETE /projects/{}",
    ],
    requiredTests: ["projects/create-delete", "projects/metadata-merge"],
    degradationKey: "project-lifecycle",
    fallback: "deny-operation",
  },
  {
    id: "project-members",
    nameKey: "project-members",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: ["spec: /projects/{}/members present in 2.10.0 through 2.15.0"],
    exceptions: [],
    operations: [
      "GET /projects/{}/members",
      "POST /projects/{}/members",
      "PUT /projects/{}/members/{}",
      "DELETE /projects/{}/members/{}",
    ],
    requiredTests: ["members/grant-revoke", "members/unknown-user"],
    degradationKey: "project-members",
    fallback: "deny-operation",
  },
  {
    id: "directory-identity",
    nameKey: "directory-identity",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "spec: /users/search and /usergroups present in 2.10.0 through 2.15.0",
      "code: clusters/identity.ts requires the Harbor directory to name a member, never a free-text field",
    ],
    exceptions: [],
    operations: ["GET /users/search", "GET /usergroups"],
    requiredTests: ["directory/user-search", "directory/group-list"],
    degradationKey: "directory-identity",
    fallback: "deny-operation",
  },
  {
    // The second configuration gate of the code after the SBOM one: whether a directory search
    // reaches the directory or only the accounts Harbor already holds (clusters/directory.ts).
    // Decided by the Harbor's configuration rather than its version, and read live.
    id: "ldap-directory",
    nameKey: "ldap-directory",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "spec: /configurations, /ldap/users/search, /ldap/users/import and /ldap/groups/search present in 2.10.0 through 2.15.0",
      "measured on 2.15.0 (2026-09-10): the LDAP searches answer from the stored ldap_* settings whatever auth_mode is, match exactly, and an empty query returns the whole directory",
      "measured on 2.15.0 (2026-09-10): import is idempotent on ldap_auth, refuses the whole batch when one uid is unknown, and fails on db_auth and oidc_auth",
      "measured on 2.15.0 (2026-09-10): an ldap_auth Harbor creates a directory account when it is granted a project, and registers a group from a DN",
    ],
    exceptions: [],
    operations: [
      "GET /configurations",
      "GET /ldap/users/search",
      "GET /ldap/groups/search",
      "POST /ldap/users/import",
      "POST /usergroups",
    ],
    requiredTests: [
      "directory/ldap-config-read",
      "directory/ldap-user-search-exact",
      "directory/ldap-group-search",
      "directory/ldap-import-idempotent",
    ],
    degradationKey: "ldap-directory",
    // Without it the search still runs, against Harbor's own accounts, and says so.
    fallback: "allow-with-warning",
  },
  {
    id: "ldap-config-write",
    nameKey: "ldap-config-write",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "spec: PUT /configurations and POST /ldap/ping present in 2.10.0 through 2.15.0; ldap_search_password is write-only (absent from ConfigurationsResponse)",
      "measured on 2.15.0 (2026-09-10): /ldap/ping tests only the body it is sent and never reuses the stored password",
      "measured on 2.15.0 (2026-09-10): auth_mode is refused as soon as a non-admin account exists, and the whole PUT with it",
    ],
    exceptions: [],
    operations: ["POST /ldap/ping", "PUT /configurations", "GET /users"],
    requiredTests: ["directory/ldap-ping-candidate", "directory/ldap-config-write"],
    degradationKey: "ldap-config-write",
    fallback: "deny-operation",
  },
  {
    id: "catalog-browse",
    nameKey: "catalog-browse",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: ["spec: repositories and artifacts listings present in 2.10.0 through 2.15.0"],
    exceptions: [],
    operations: [
      "GET /projects/{}/repositories",
      "GET /projects/{}/repositories/{}/artifacts",
      "GET /projects/{}/repositories/{}/artifacts/{}",
      "GET /projects/{}/repositories/{}/artifacts/{}/tags",
      "GET /search",
    ],
    requiredTests: ["catalog/list-repositories", "catalog/list-artifacts"],
    degradationKey: "catalog-browse",
    fallback: "deny-operation",
  },
  {
    id: "artifact-delete",
    nameKey: "artifact-delete",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: ["spec: artifact and repository DELETE present in 2.10.0 through 2.15.0"],
    exceptions: [],
    operations: [
      "DELETE /projects/{}/repositories/{}",
      "DELETE /projects/{}/repositories/{}/artifacts/{}",
    ],
    requiredTests: ["artifacts/delete-by-digest", "artifacts/delete-removes-all-tags"],
    degradationKey: "artifact-delete",
    fallback: "deny-operation",
  },
  {
    id: "vulnerability-scan",
    nameKey: "vulnerability-scan",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "spec: scan trigger and vulnerability addition present in 2.10.0 through 2.15.0",
      "code: harbor.ts reads the report through ARTIFACT_SCAN_EXPANSIONS, one scanner assumed",
    ],
    exceptions: [],
    operations: [
      "POST /projects/{}/repositories/{}/artifacts/{}/scan",
      "GET /projects/{}/repositories/{}/artifacts/{}/additions/vulnerabilities",
    ],
    requiredTests: ["scan/trigger", "scan/read-report"],
    degradationKey: "vulnerability-scan",
    fallback: "deny-operation",
  },
  {
    id: "sbom-generation",
    nameKey: "sbom-generation",
    // The conservative bound of the two below. Omitting the key on a 2.11 that would have taken
    // it costs a feature; sending it to a Harbor that rejects unknown metadata keys costs the
    // whole PUT, auto_scan included. Until a test settles it, the cheap failure is the right one.
    since: "2.12",
    sinceConfidence: "disputed",
    availabilityEvidence: [
      "code: harborSupportsSbom() has required 2.12 since it was written (harbor.ts)",
      "spec: auto_sbom_generation is in ProjectMetadata in the 2.11.0 swagger and absent from 2.10.0 — measured 2026-09-08",
      "unsettled: whether 2.11 accepts the key and produces a document is a conformance question, not a spec one (plan D1)",
    ],
    exceptions: [],
    operations: [
      "PUT /projects/{}",
      "POST /projects/{}/repositories/{}/artifacts/{}/scan",
      "GET /projects/{}/repositories/{}/artifacts/{}",
    ],
    requiredTests: ["sbom/enable", "sbom/metadata-merge-preserves-siblings", "sbom/read-format"],
    degradationKey: "sbom-generation",
    fallback: "omit-field",
  },
  {
    id: "cosign-signature",
    nameKey: "cosign-signature",
    since: "2.11",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "upstream: Notary v1 / DCT removed in 2.11, Cosign accessories are the remaining signature path",
      "code: with_signature and with_accessories are requested but never cryptographically verified",
    ],
    exceptions: [],
    operations: ["GET /projects/{}/repositories/{}/artifacts/{}"],
    requiredTests: ["signature/detect-present", "signature/detect-absent"],
    degradationKey: "cosign-signature",
    fallback: "allow-with-warning",
  },
  {
    id: "system-robot",
    nameKey: "system-robot",
    since: "2.2",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "upstream: robot accounts v2 (system level, /robots) landed in 2.2",
      "code: harbor.ts warns that the robot permission vocabulary and the duration unit have shifted across 2.x",
    ],
    exceptions: [],
    operations: ["GET /robots", "POST /robots", "PATCH /robots/{}", "DELETE /robots/{}"],
    requiredTests: ["robot/create", "robot/effective-permissions", "robot/delete"],
    degradationKey: "system-robot",
    fallback: "deny-operation",
  },
  {
    id: "retention-policy",
    nameKey: "retention-policy",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: ["spec: /retentions present in 2.10.0 through 2.15.0"],
    exceptions: [],
    operations: ["POST /retentions", "PUT /retentions/{}"],
    requiredTests: ["retention/create", "retention/update"],
    degradationKey: "retention-policy",
    fallback: "deny-operation",
  },
  {
    id: "project-quota",
    nameKey: "project-quota",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: ["spec: /quotas present in 2.10.0 through 2.15.0"],
    exceptions: [],
    operations: ["GET /quotas", "PUT /quotas/{}"],
    requiredTests: ["quota/read", "quota/set"],
    degradationKey: "project-quota",
    fallback: "deny-operation",
  },
  {
    id: "replication-endpoint",
    nameKey: "replication-endpoint",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "spec: /registries CRUD and /registries/ping present in 2.10.0 through 2.15.0",
      "code: replication.ts updates an existing endpoint rather than recreating it, because POST answers 409",
    ],
    exceptions: [],
    operations: [
      "GET /registries",
      "POST /registries",
      "GET /registries/{}",
      "PUT /registries/{}",
      "DELETE /registries/{}",
      "POST /registries/ping",
    ],
    requiredTests: ["replication/endpoint-upsert", "replication/ping-from-source", "replication/endpoint-in-use-refuses-delete"],
    degradationKey: "replication-endpoint",
    fallback: "deny-operation",
  },
  {
    id: "replication-policy",
    nameKey: "replication-policy",
    since: "2.0",
    sinceConfidence: "declared",
    availabilityEvidence: [
      "spec: /replication/policies and /replication/executions present in 2.10.0 through 2.15.0",
      "code: replication.ts disables a policy before deleting it, Harbor answering 412 while an execution is not final",
    ],
    exceptions: [],
    operations: [
      "GET /replication/policies",
      "POST /replication/policies",
      "GET /replication/policies/{}",
      "PUT /replication/policies/{}",
      "DELETE /replication/policies/{}",
      "GET /replication/executions",
      "POST /replication/executions",
      "GET /replication/executions/{}",
    ],
    // Version-agnostic on purpose: a required test named after a version could never pass on any
    // other one, and the version a run covers is the run's own property. Cross-version pairs are
    // separate scenarios, recorded per direction (plan §3.3), not requirements of the capability.
    requiredTests: ["replication/policy-apply", "replication/disable-before-delete"],
    degradationKey: "replication-policy",
    fallback: "deny-operation",
  },
])

export function capabilityById(id: string): HarborCapability | undefined {
  return HARBOR_CAPABILITIES.find((capability) => capability.id === id)
}

// ---------------------------------------------------------------------------------------------
// Availability — a technical question, decided by version alone
// ---------------------------------------------------------------------------------------------

export type Availability = "available" | "unavailable" | "unknown"

/**
 * Whether the function exists on this Harbor.
 *
 * "unknown" is a real answer and never collapses into "unavailable": an anonymous /systeminfo
 * returns no version, and a Harbor whose version we cannot read is not thereby old. What each
 * caller does with the uncertainty is the capability's `fallback`, not this function's business.
 */
export function capabilityAvailability(
  capability: HarborCapability,
  version: HarborVersion | null,
): Availability {
  if (!version) return "unknown"

  for (const exception of capability.exceptions) {
    if (versionMatches(version, exception.range)) return exception.available ? "available" : "unavailable"
  }

  if (capability.since === null) return "unknown"
  if (!versionMatches(version, `>=${capability.since}`)) return "unavailable"
  if (capability.removedIn && versionMatches(version, `>=${capability.removedIn}`)) return "unavailable"
  return "available"
}

// ---------------------------------------------------------------------------------------------
// Support policy — a commitment, declared per Gateway release
// ---------------------------------------------------------------------------------------------

export type SupportStatus = "supported" | "below-floor" | "above-tested" | "unknown"

/**
 * What the Gateway commits to, as opposed to what it happens to work with.
 *
 * The floor is provisional until the first conformance campaign (plan D1): it is the floor the
 * code already applies through the SBOM guard, not a measured one. Nothing here disables a
 * function — being outside the window is a warning, never a reason to refuse (plan D4).
 */
export const HARBOR_SUPPORT_POLICY = Object.freeze({
  floor: "2.12",
  floorConfidence: "provisional" as "provisional" | "confirmed",
  /** Exact versions a conformance campaign has covered. Empty until lot 2 runs. */
  verifiedVersions: Object.freeze([] as string[]),
  /** Newest minor known upstream at the time of writing; used to spot ageing proofs. */
  latestKnownMinor: "2.15",
})

export function supportStatus(version: HarborVersion | null): SupportStatus {
  if (!version) return "unknown"
  if (!versionMatches(version, `>=${HARBOR_SUPPORT_POLICY.floor}`)) return "below-floor"
  const verified = HARBOR_SUPPORT_POLICY.verifiedVersions
  if (verified.length > 0 && !verified.some((exact) => formatVersion(version) === exact)) {
    const newest = verified
      .map((exact) => parseHarborVersion(exact))
      .filter((parsed): parsed is HarborVersion => parsed !== null)
      .sort(compareVersions)
      .at(-1)
    if (newest && compareVersions(version, newest) > 0) return "above-tested"
  }
  return "supported"
}

// ---------------------------------------------------------------------------------------------
// Proof — what actually ran
// ---------------------------------------------------------------------------------------------

export type TestResult = "pass" | "fail" | "skipped"

/** One conformance run, as stored in docs/harbor-conformance.json. Never written by hand. */
export interface ConformanceRun {
  capabilityId: string
  /** The version read *on the instance*, not the one the job was asked for. */
  harborVersion: string
  gatewayCommit: string
  /** Digest of the files implementing this capability, from tools/harbor-surface.ts. */
  surfaceDigest: string
  suiteRevision: string
  tests: Array<{ id: string; result: TestResult; symptom?: string }>
  runId: string
  finishedAt: string
  reportUrl?: string
  context: Record<string, string>
}

/** A spec comparison, as stored in docs/harbor-spec-evidence.json. */
export interface SpecEvidence {
  capabilityId: string
  fromVersion: string
  toVersion: string
  /** False when a $ref could not be resolved: an incomplete comparison proves nothing. */
  complete: boolean
  breakingChanges: string[]
}

export type ProofState = "verified" | "expected" | "broken" | "inconclusive" | "unknown"

export interface CapabilityAssessment {
  capabilityId: HarborCapabilityId
  availability: Availability
  support: SupportStatus
  proof: ProofState
  /** The run the proof rests on, when there is one. */
  provenBy?: ConformanceRun
  /** True when the newest run for this context could not conclude — the older pass still shows. */
  lastRunInconclusive: boolean
  /** True when the proof stands but has aged past the threshold (§2). */
  stale: boolean
  /** Machine-readable reason, translated by the UI; never a sentence built here. */
  reasonKey: string
}

/** A proof older than this is shown as aged. Not a failure — a prompt to re-run. */
export const PROOF_STALE_AFTER_DAYS = 180

/**
 * Combines availability, support and proof for one capability on one exact version.
 *
 * The rules that matter, all of them from plan §2:
 *
 *  - a run only counts for the exact version it ran on, and only while the capability's surface
 *    digest still matches — a Gateway commit that rewrote the calls invalidates its own proof,
 *    and one that touched nothing behind this capability leaves it standing;
 *  - a functional failure outranks everything else, including a clean spec diff;
 *  - an environment that never came up is `inconclusive`, never `broken`: blaming Harbor for our
 *    own CI is how a matrix loses its readers;
 *  - `expected` requires a *complete* comparison against a reference that is itself verified.
 */
export function evaluateCapability(input: {
  capability: HarborCapability
  version: HarborVersion | null
  runs: readonly ConformanceRun[]
  specEvidence?: readonly SpecEvidence[]
  /** Current per-capability digests, keyed by capability id (tools/harbor-surface.ts). */
  surfaceDigests: Readonly<Record<string, string>>
  now?: Date
}): CapabilityAssessment {
  const { capability, version, runs, specEvidence = [], surfaceDigests, now = new Date() } = input
  const availability = capabilityAvailability(capability, version)
  const support = supportStatus(version)
  const base = {
    capabilityId: capability.id,
    availability,
    support,
    lastRunInconclusive: false,
    stale: false,
  }

  if (!version) return { ...base, proof: "unknown", reasonKey: "version-unreadable" }

  const currentDigest = surfaceDigests[capability.id]
  const applicable = runs
    .filter((run) => run.capabilityId === capability.id)
    .filter((run) => parseHarborVersion(run.harborVersion) !== null)
    .filter((run) => formatVersion(parseHarborVersion(run.harborVersion)!) === formatVersion(version))
    // A run whose surface digest no longer matches described code that no longer exists.
    .filter((run) => currentDigest === undefined || run.surfaceDigest === currentDigest)
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))

  const latest = applicable.at(-1)

  // The verdict is folded per *test*, not per run: for each required test, the newest run that
  // actually exercised it wins. A run that skipped a test brings no news about it, and a failure
  // that a later run turned into a pass is a fixed failure, not a standing one — keeping it
  // would leave a capability marked broken by a defect that no longer reproduces.
  const newest = new Map<string, { result: TestResult; run: ConformanceRun }>()
  for (const run of applicable) {
    for (const test of run.tests) {
      if (test.result === "skipped") continue
      if (capability.requiredTests.includes(test.id)) newest.set(test.id, { result: test.result, run })
    }
  }

  const failing = capability.requiredTests.filter((id) => newest.get(id)?.result === "fail")
  if (failing.length > 0) {
    return { ...base, proof: "broken", provenBy: newest.get(failing[0])!.run, reasonKey: "test-failed" }
  }

  if (capability.requiredTests.every((id) => newest.get(id)?.result === "pass")) {
    // The proof rests on the newest of the runs that carried those passes.
    const backing = capability.requiredTests
      .map((id) => newest.get(id)!.run)
      .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
      .at(-1)!
    return {
      ...base,
      proof: "verified",
      provenBy: backing,
      lastRunInconclusive: latest !== undefined && outcomeOf(latest, capability) === "inconclusive",
      stale: isProofStale(backing, now),
      reasonKey: "verified",
    }
  }

  if (latest) {
    return { ...base, proof: "inconclusive", provenBy: latest, reasonKey: "run-inconclusive" }
  }

  const clean = specEvidence.some(
    (evidence) =>
      evidence.capabilityId === capability.id &&
      evidence.complete &&
      evidence.breakingChanges.length === 0 &&
      // The reference itself must be verified, or "expected" would rest on nothing.
      runs.some(
        (run) =>
          run.capabilityId === capability.id &&
          run.harborVersion === evidence.fromVersion &&
          outcomeOf(run, capability) === "verified" &&
          (currentDigest === undefined || run.surfaceDigest === currentDigest),
      ),
  )
  if (clean) return { ...base, proof: "expected", reasonKey: "spec-unchanged" }

  return { ...base, proof: "unknown", reasonKey: "never-run" }
}

/**
 * What one run concluded.
 *
 * A capability is verified only when every one of its required tests passed in that run: a suite
 * that skipped one of them proves the others and nothing more, so it stays inconclusive. A single
 * functional failure is enough for `broken`, even if the rest of the run never happened.
 */
export function outcomeOf(run: ConformanceRun, capability: HarborCapability): ProofState {
  const byId = new Map(run.tests.map((test) => [test.id, test.result]))
  if (capability.requiredTests.some((id) => byId.get(id) === "fail")) return "broken"
  if (capability.requiredTests.length === 0) return "inconclusive"
  return capability.requiredTests.every((id) => byId.get(id) === "pass") ? "verified" : "inconclusive"
}

/**
 * Whether a standing proof has aged out.
 *
 * Age is deliberately computed from `now` rather than baked into a file: the generated doc prints
 * the date and the commit and stays byte-identical between runs, and the UI derives staleness at
 * request time. A threshold that changed a versioned file would make `--check` fail one morning
 * with no commit behind it.
 */
export function isProofStale(run: ConformanceRun, now: Date = new Date()): boolean {
  const ageDays = (now.getTime() - Date.parse(run.finishedAt)) / 86_400_000
  if (ageDays > PROOF_STALE_AFTER_DAYS) return true
  const proven = parseHarborVersion(run.harborVersion)
  const latest = parseHarborVersion(HARBOR_SUPPORT_POLICY.latestKnownMinor)
  return proven !== null && latest !== null && minorOf(proven) !== minorOf(latest)
}

/**
 * Whether a set of members disagrees on its Harbor minor.
 *
 * The operational trap the fleet page exists to show: a replication policy the Gateway writes on
 * a 2.15 member toward an older peer behaves according to whichever end does the work, and
 * nothing else in the fleet view says the two are not the same software. A member whose version
 * could not be read is *silence*, not divergence, and is counted apart — folding it into
 * agreement would be inventing a reading.
 *
 * Lives here rather than in compatibility.ts because the fleet board is a client component: this
 * module is pure, that one imports the evidence files.
 */
export function minorSpread(versions: Array<string | null | undefined>): { minors: string[]; unknown: number } {
  const minors = new Set<string>()
  let unknown = 0
  for (const version of versions) {
    const parsed = parseHarborVersion(version ?? null)
    if (!parsed) unknown += 1
    else minors.add(minorOf(parsed))
  }
  return { minors: [...minors].sort(), unknown }
}
