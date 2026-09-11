import { registryFetch } from "./http"
import { isValidDigest, isValidReference, isValidRepositoryPath } from "./v2-client"
import { capabilityAvailability, capabilityById, parseHarborVersion } from "./harbor-capabilities"
import type {
  HarborSupplyChainSummary,
  HarborVulnerabilitySummary,
  RegistryConnection,
} from "./types"

// The write calls below (createHarborProject, robot accounts, retention) are implemented
// against Harbor's documented v2.0 REST API (https://{harbor}/devcenter, "OpenAPI" spec) but
// have not been exercised against a live Harbor instance — no reachable Harbor was available
// to test against. Field names in particular (robot `duration` unit, permission `resource`/
// `action` vocab) are known to have shifted slightly across Harbor 2.x releases. Smoke-test
// these against the target Harbor version before relying on them.

// Harbor's liveness probe. Answers "Pong" on every Harbor 2.x, and — unlike /systeminfo —
// does so without credentials, so it identifies a Harbor even when the configured auth is
// wrong or missing. A plain Docker Registry v2 endpoint has no /api/v2.0 namespace at all.
export async function harborPing(conn: RegistryConnection): Promise<boolean> {
  try {
    const res = await registryFetch(conn, "/api/v2.0/ping")
    if (!res.ok) return false
    return (await res.text()).trim().replace(/^"|"$/g, "").toLowerCase() === "pong"
  } catch {
    return false
  }
}

// Harbor only fills `harbor_version` in for an authenticated caller — an anonymous GET
// returns a trimmed-down body. A null here therefore means "couldn't read it", not
// "not a Harbor"; use harborPing() for the identity question.
export async function getHarborVersion(conn: RegistryConnection): Promise<string | null> {
  try {
    const res = await registryFetch(conn, "/api/v2.0/systeminfo")
    if (!res.ok) return null
    const body = (await res.json()) as { harbor_version?: string }
    return body.harbor_version ?? null
  } catch {
    return null
  }
}

export interface HarborProject {
  projectId: number
  name: string
  repoCount: number
  isPublic: boolean
  /** Harbor `metadata.auto_scan` — scan every image as it is pushed. */
  autoScan: boolean
  /** Harbor `metadata.auto_sbom_generation` — Harbor 2.12+; false on older instances. */
  autoSbom: boolean
}

// Harbor stores every project metadata value as the *string* "true"/"false", and omits the
// key entirely when it was never set — which is indistinguishable from false, and is what an
// instance too old to know the key does as well.
function harborFlag(value: string | boolean | undefined): boolean {
  return String(value) === "true"
}

// Harbor stores visibility as the *string* "true"/"false" under metadata.public, and omits
// the key entirely on some versions — hence the explicit comparison rather than a cast.
export async function listHarborProjects(conn: RegistryConnection): Promise<HarborProject[]> {
  const res = await registryFetch(conn, "/api/v2.0/projects?page_size=100")
  if (!res.ok) throw new Error(`Harbor projects request failed (${res.status})`)
  const body = (await res.json()) as Array<{
    project_id: number
    name: string
    repo_count: number
    metadata?: { public?: string | boolean; auto_scan?: string; auto_sbom_generation?: string }
  }>
  return body.map((p) => ({
    projectId: p.project_id,
    name: p.name,
    repoCount: p.repo_count,
    isPublic: harborFlag(p.metadata?.public),
    autoScan: harborFlag(p.metadata?.auto_scan),
    autoSbom: harborFlag(p.metadata?.auto_sbom_generation),
  }))
}

// `repo` is the full catalog name, e.g. "my-project/my-app" — Harbor's artifact API
// splits that into project + repository segments.
function splitHarborRepo(repo: string): { project: string; repository: string } {
  const [project, ...rest] = repo.split("/")
  return { project, repository: rest.join("/") || project }
}

// Harbor keys its repository routes on the name *within* the project, and expects that
// segment percent-encoded twice when it is nested ("team/api" → "team%252Fapi"). Encoding
// twice unconditionally is harmless for a flat name, which survives the first pass unchanged.
function encodeHarborRepository(repository: string): string {
  return encodeURIComponent(encodeURIComponent(repository))
}

export interface HarborRepository {
  /** Name inside the project, i.e. the full name with the `<project>/` prefix stripped. */
  name: string
  /**
   * What its artifacts are, when it was worth asking — see listHarborRepositoryKinds().
   * Undefined means "not determined", never "image": the row then draws a neutral icon.
   */
  kind?: ArtifactKind
  artifactCount: number
  pullCount: number
  updatedAt: string | null
}

// Everything the project holds on one Harbor. This is the project-scoped counterpart of the
// registry-wide /v2/_catalog: it needs no admin rights on the whole registry, and it carries
// the artifact and pull counts the catalog has no idea about.
export async function listHarborRepositories(
  conn: RegistryConnection,
  projectName: string
): Promise<HarborRepository[]> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(projectName)}/repositories?page_size=100`
  )
  if (!res.ok) throw new Error(`Harbor repository list failed (${res.status})`)

  const body = (await res.json()) as Array<{
    name: string
    artifact_count?: number
    pull_count?: number
    update_time?: string
  }>
  return body.map((repo) => ({
    // Harbor reports the fully qualified name here, project prefix included.
    name: repo.name.startsWith(`${projectName}/`) ? repo.name.slice(projectName.length + 1) : repo.name,
    artifactCount: repo.artifact_count ?? 0,
    pullCount: repo.pull_count ?? 0,
    updatedAt: repo.update_time ?? null,
  }))
}

/**
 * What an OCI artifact actually is.
 *
 * A registry has not held only container images for years — a Helm chart, a WASM module and a
 * CNAB bundle all sit in the same repository shape, and reading one as an image is how a chart
 * ends up displayed with an empty platform and no version. Harbor already classifies them; the
 * only reason the Gateway showed them all alike is that this parser used to discard the field.
 */
export type ArtifactKind = "image" | "chart" | "other"

/** Chart.yaml, as Harbor extracted it — null on anything that is not a chart. */
export interface ArtifactChartInfo {
  version: string | null
  appVersion: string | null
  description: string | null
}

export interface ArtifactMeta {
  kind: ArtifactKind
  /** Harbor's own type string ("IMAGE", "CHART", "CNAB", "WASM"…), kept for the "other" case. */
  rawType: string | null
  /** Config media type — "application/vnd.cncf.helm.config.v1+json" for a chart. */
  mediaType: string | null
  /** "linux/amd64" when Harbor knows, null for an index it hasn't expanded — or for a chart. */
  platform: string | null
  chart: ArtifactChartInfo | null
}

export interface HarborArtifact extends ArtifactMeta {
  digest: string
  /** Empty for an untagged (dangling) artifact — Harbor keeps those listed. */
  tags: string[]
  size: number
  pushedAt: string | null
  vulnerabilities: HarborVulnerabilitySummary | null
  /** Cosign signature / SBOM / attestation state — null when this is not a Harbor. */
  supplyChain: HarborSupplyChainSummary | null
}

// Everything Harbor reports about an artifact beyond its bytes. Written once because the list
// endpoint and the single-artifact endpoint return the same object, and reading it two
// different ways is how a chart would come out classified on one screen and not the other.
interface RawArtifact {
  type?: string
  media_type?: string
  extra_attrs?: {
    os?: string
    architecture?: string
    version?: string
    appVersion?: string
    description?: string
  }
}

// The scan and supply-chain fields Harbor fills only when explicitly asked — via
// `with_scan_overview` / `with_sbom_overview` / `with_signature` / `with_accessories`. Both
// the list and the single-artifact endpoint return this same shape, so it is read once here.
interface RawScanReport {
  scan_status?: string
  severity?: string
  summary?: { total?: number; fixable?: number; summary?: Record<string, number> }
  end_time?: string
  scanner?: { name?: string; version?: string }
}
interface RawArtifactExtras {
  digest: string
  size?: number
  push_time?: string
  tags?: Array<{ name: string; signed?: boolean }> | null
  scan_overview?: Record<string, RawScanReport>
  sbom_overview?: { scan_status?: string; sbom_digest?: string; end_time?: string }
  accessories?: Array<{ type?: string }> | null
}

// Every read that wants the scan summary or the supply-chain state asks for the same four
// expansions. Kept in one place so the list and detail endpoints cannot drift apart.
const ARTIFACT_SCAN_EXPANSIONS =
  "with_scan_overview=true&with_sbom_overview=true&with_signature=true&with_accessories=true"

function artifactMeta(artifact: RawArtifact): ArtifactMeta {
  const rawType = artifact.type ?? null
  const kind: ArtifactKind =
    rawType === "CHART" ? "chart" : rawType === "IMAGE" || rawType == null ? "image" : "other"

  const os = artifact.extra_attrs?.os
  const arch = artifact.extra_attrs?.architecture

  return {
    kind,
    rawType,
    mediaType: artifact.media_type ?? null,
    platform: os && arch ? `${os}/${arch}` : null,
    // Harbor puts the parsed Chart.yaml straight into extra_attrs, so there is nothing to
    // fetch or unpack — only to stop throwing away.
    chart:
      kind === "chart"
        ? {
            version: artifact.extra_attrs?.version ?? null,
            appVersion: artifact.extra_attrs?.appVersion ?? null,
            description: artifact.extra_attrs?.description ?? null,
          }
        : null,
  }
}

export async function listHarborArtifacts(
  conn: RegistryConnection,
  projectName: string,
  repository: string
): Promise<HarborArtifact[]> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(projectName)}/repositories/${encodeHarborRepository(repository)}` +
      `/artifacts?with_tag=true&${ARTIFACT_SCAN_EXPANSIONS}&page_size=100`
  )
  if (!res.ok) throw new Error(`Harbor artifact list failed (${res.status})`)

  const body = (await res.json()) as Array<RawArtifact & RawArtifactExtras>

  return body.map((artifact) => ({
    ...artifactMeta(artifact),
    digest: artifact.digest,
    tags: (artifact.tags ?? []).map((tag) => tag.name),
    size: artifact.size ?? 0,
    pushedAt: artifact.push_time ?? null,
    vulnerabilities: summarizeScanOverview(artifact.scan_overview),
    supplyChain: summarizeSupplyChain(artifact),
  }))
}

/** Resolve one tag directly, including artifacts outside the first page of a repository. */
export async function getHarborArtifactDigest(
  conn: RegistryConnection,
  projectName: string,
  repository: string,
  reference: string,
): Promise<string | null> {
  if (!isValidRepositoryPath(projectName) || projectName.includes("/") || !isValidRepositoryPath(repository)) {
    throw new Error("Invalid repository path")
  }
  if (!isValidReference(reference)) throw new Error("Invalid manifest reference")

  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(projectName)}/repositories/${encodeHarborRepository(repository)}` +
      `/artifacts/${encodeURIComponent(reference)}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Harbor artifact request failed (${res.status})`)

  const body = (await res.json()) as { digest?: unknown }
  if (typeof body.digest !== "string" || !isValidDigest(body.digest)) {
    throw new Error("Invalid manifest digest returned by Harbor")
  }
  return body.digest
}

// Harbor keys the scan summary by the scanner's report MIME type. Trivy is the only scanner
// the Gateway aggregates (docs/plan-supply-chain.md D2); a known report type wins, and when
// several scanners are registered the rest are ignored rather than merged.
const KNOWN_SCAN_REPORT_TYPES = [
  "application/vnd.security.vulnerability.report; version=1.1",
  "application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.0",
]

// Harbor keys both the scan overview and the full vulnerability report by the same set of
// report MIME types, so one picker serves both.
function pickKnownReport<T>(record: Record<string, T> | undefined): T | undefined {
  if (!record) return undefined
  for (const type of KNOWN_SCAN_REPORT_TYPES) {
    if (record[type]) return record[type]
  }
  return Object.values(record)[0]
}

function summarizeScanOverview(
  overview: Record<string, RawScanReport> | undefined
): HarborVulnerabilitySummary | null {
  const report = pickKnownReport(overview)
  if (!report) return null

  const summary = report.summary?.summary ?? {}
  const scanner = report.scanner?.name
    ? report.scanner.version
      ? `${report.scanner.name} ${report.scanner.version}`
      : report.scanner.name
    : undefined

  const buckets = {
    critical: summary.Critical ?? 0,
    high: summary.High ?? 0,
    medium: summary.Medium ?? 0,
    low: summary.Low ?? 0,
    unknown: summary.Unknown ?? 0,
  }

  return {
    ...buckets,
    // Harbor's own count when it gives one. The bucket sum is only a fallback: any severity
    // label not enumerated above would otherwise vanish from the total as well as the bars.
    total: report.summary?.total ?? Object.values(buckets).reduce((sum, n) => sum + n, 0),
    fixable: report.summary?.fixable,
    scanner,
    scanStatus: report.scan_status,
    scanCompletedAt: report.end_time,
  }
}

// Cosign is the only signature scheme Harbor still supports (Notary v1 was removed in 2.11),
// and it stores signatures, SBOMs and attestations as OCI accessories of the image. This only
// reports what Harbor already knows — it does not fetch or verify the signature (deferred,
// docs/plan-supply-chain.md lot 7).
//
// Null when Harbor said nothing — neither the accessory list nor the SBOM overview came back,
// which is what a non-Harbor registry or a pre-2.11 Harbor looks like. `signed: false` is the
// opposite: Harbor answered and there is no signature.
function summarizeSupplyChain(raw: RawArtifactExtras): HarborSupplyChainSummary | null {
  if (raw.accessories === undefined && raw.sbom_overview === undefined) return null

  const accessories = raw.accessories ?? []
  const signatureCount = accessories.filter((a) => a.type?.startsWith("signature")).length
  const attestationCount = accessories.filter((a) => a.type?.includes("attestation")).length
  const signedTag = (raw.tags ?? []).some((tag) => tag.signed)

  return {
    signed: signatureCount > 0 || signedTag,
    sbom: accessories.some((a) => a.type === "sbom") || Boolean(raw.sbom_overview?.sbom_digest),
    signatureCount,
    attestationCount,
  }
}

/**
 * The artifacts of a repository named the way the rest of the app names one — "fdsf/nginx",
 * project prefix included — rather than as a (project, repository) pair.
 *
 * The repository pages carry the joined form because that is what an image reference looks
 * like; splitting it at every call site is how one of them eventually splits it differently.
 */
export async function listHarborArtifactsByRepo(
  conn: RegistryConnection,
  repo: string
): Promise<HarborArtifact[]> {
  const { project, repository } = splitHarborRepo(repo)
  return listHarborArtifacts(conn, project, repository)
}

/**
 * What kind of artifact each of these repositories holds, keyed by repository name.
 *
 * A Harbor repository has no type of its own — only its artifacts do — so this costs one
 * request per repository and is therefore bounded twice: `maxRepositories` gives up entirely
 * on a long list rather than issuing hundreds of calls, and the requests go out in small
 * batches so a project with thirty repositories does not open thirty sockets at once. A
 * repository missing from the result simply renders with the neutral icon.
 *
 * The first artifact decides. A repository mixing charts and images is possible and would be
 * labelled by whichever Harbor returns first — an ambiguity worth accepting for an icon,
 * since the artifact rows inside the repository each carry their own kind.
 */
export async function listHarborRepositoryKinds(
  conn: RegistryConnection,
  projectName: string,
  repositories: string[],
  maxRepositories = 40
): Promise<Record<string, ArtifactKind>> {
  if (repositories.length === 0 || repositories.length > maxRepositories) return {}

  const kinds: Record<string, ArtifactKind> = {}
  const BATCH = 8

  for (let i = 0; i < repositories.length; i += BATCH) {
    await Promise.all(
      repositories.slice(i, i + BATCH).map(async (repository) => {
        try {
          const res = await registryFetch(
            conn,
            `/api/v2.0/projects/${encodeURIComponent(projectName)}/repositories/${encodeHarborRepository(repository)}` +
              `/artifacts?page_size=1`
          )
          if (!res.ok) return
          const body = (await res.json()) as RawArtifact[]
          if (body.length > 0) kinds[repository] = artifactMeta(body[0]).kind
        } catch {
          // One unreadable repository must not cost the whole list its icons.
        }
      })
    )
  }

  return kinds
}

export interface HarborArtifactDetail extends ArtifactMeta {
  vulnerabilities: HarborVulnerabilitySummary | null
  supplyChain: HarborSupplyChainSummary | null
}

/**
 * Everything Harbor knows about one artifact: what it is, what platform it targets, and its
 * scan summary.
 *
 * One request rather than two — the vulnerability summary and the artifact's type come from
 * the same endpoint, and asking twice for one object would double the latency of opening the
 * detail panel for no gain.
 *
 * Null when the artifact cannot be read at all. A registry that is not a Harbor, or an
 * artifact Harbor has never indexed, must leave the panel showing its manifest rather than
 * failing: the manifest comes from the OCI API and is always available.
 */
export async function getHarborArtifactDetail(
  conn: RegistryConnection,
  repo: string,
  reference: string
): Promise<HarborArtifactDetail | null> {
  const { project, repository } = splitHarborRepo(repo)
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeHarborRepository(repository)}/artifacts/${encodeURIComponent(reference)}?${ARTIFACT_SCAN_EXPANSIONS}`
  )
  if (!res.ok) return null

  const body = (await res.json()) as RawArtifact & RawArtifactExtras
  return {
    ...artifactMeta(body),
    vulnerabilities: summarizeScanOverview(body.scan_overview),
    supplyChain: summarizeSupplyChain(body),
  }
}

/**
 * Removes one artifact from one Harbor, by tag or by digest.
 *
 * A 404 is success: the artifact is already gone, which is the desired end state — and what a
 * replayed delete finds after a first attempt got through.
 *
 * Deleting by *tag* deletes the artifact the tag points at, tags and all: Harbor has no
 * "untag" on this endpoint. That is why the UI deletes by digest and names the tags that go
 * with it, rather than letting a tag look like the thing being removed.
 */
export async function deleteHarborArtifact(
  conn: RegistryConnection,
  project: string,
  repository: string,
  reference: string
): Promise<void> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeHarborRepository(repository)}/artifacts/${encodeURIComponent(reference)}`,
    { method: "DELETE" }
  )
  if (res.ok || res.status === 404) return
  throw new Error(`Harbor artifact deletion failed (${res.status})`)
}

/** The whole repository, artifacts included. Same 404-is-success rule as above. */
export async function deleteHarborRepository(
  conn: RegistryConnection,
  project: string,
  repository: string
): Promise<void> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeHarborRepository(repository)}`,
    { method: "DELETE" }
  )
  if (res.ok || res.status === 404) return
  throw new Error(`Harbor repository deletion failed (${res.status})`)
}

// One CVE against one package, flattened from Harbor's report. `fixVersion` null means "no fix
// published" — the distinction the summary counts cannot make.
export interface HarborVulnerability {
  id: string
  package: string
  version: string
  fixVersion: string | null
  severity: string
  /** CVSS v3 base score when Harbor has one, else v2, else null. */
  cvssScore: number | null
  description: string | null
  links: string[]
}

interface RawVulnerability {
  id?: string
  package?: string
  version?: string
  fix_version?: string
  severity?: string
  description?: string
  links?: string[]
  preferred_cvss?: { score_v3?: number | null; score_v2?: number | null }
}

// Worst first. Anything Harbor labels outside this list (none / unknown / negligible) sorts
// last, then ties break on package name so the list is stable between reads.
const SEVERITY_RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 }
const severityRank = (s: string) => SEVERITY_RANK[s] ?? 9

/**
 * The full vulnerability list for one artifact — every CVE, its package, the fixed version
 * when one exists, and a link.
 *
 * Null when Harbor cannot answer: not a Harbor, artifact never scanned, or a scanner that
 * does not expose the `additions` report. An empty array is a real answer — scanned, nothing
 * found. Kept out of getHarborArtifactDetail on purpose: a report runs to hundreds of rows
 * and the detail panel opens without it, fetching only when the user asks.
 */
export async function getHarborArtifactVulnerabilities(
  conn: RegistryConnection,
  repo: string,
  reference: string
): Promise<HarborVulnerability[] | null> {
  const { project, repository } = splitHarborRepo(repo)
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeHarborRepository(repository)}/artifacts/${encodeURIComponent(reference)}/additions/vulnerabilities`
  )
  if (!res.ok) return null

  const report = pickKnownReport(
    (await res.json()) as Record<string, { vulnerabilities?: RawVulnerability[] }>
  )
  if (!report?.vulnerabilities) return null

  return report.vulnerabilities
    .map((v) => ({
      id: v.id ?? "",
      package: v.package ?? "",
      version: v.version ?? "",
      fixVersion: v.fix_version || null,
      severity: v.severity ?? "Unknown",
      cvssScore: v.preferred_cvss?.score_v3 ?? v.preferred_cvss?.score_v2 ?? null,
      description: v.description || null,
      links: v.links ?? [],
    }))
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        a.package.localeCompare(b.package) ||
        a.id.localeCompare(b.id)
    )
}

/** An SBOM document plus what it turned out to be, so a caller can name the file honestly. */
export interface HarborSbom {
  document: unknown
  /** "spdx", "cyclonedx", or "json" when the document announces neither. */
  format: "spdx" | "cyclonedx" | "json"
}

/**
 * The SBOM Harbor holds for one artifact.
 *
 * Not `additions/sbom`: that endpoint answers 400 "addition SBOM isn't supported for
 * IMAGE(manifest version 2)" on Harbor 2.15 whether the artifact is a manifest or an index —
 * verified against a live 2.15.0 with Trivy v0.69.3, on an SBOM that had just been generated
 * successfully. The document is reachable only through the registry API, in three hops:
 *
 *   1. `sbom_overview.sbom_digest` on the artifact — the OCI object Harbor wrote;
 *   2. that digest's manifest, whose config is `application/vnd.goharbor.harbor.sbom.v1`;
 *   3. its single layer's blob, which is the document itself.
 *
 * Null when there is nothing to fetch. A *multi-arch index* is the case worth knowing about:
 * Harbor reports its SBOM scan as Success but writes no `sbom_digest`, so there is genuinely
 * no document to hand over — the SBOM exists per-platform, not for the index.
 */
export async function getHarborArtifactSbom(
  conn: RegistryConnection,
  repo: string,
  reference: string
): Promise<HarborSbom | null> {
  const { project, repository } = splitHarborRepo(repo)
  const artifactRes = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeHarborRepository(repository)}/artifacts/${encodeURIComponent(reference)}?with_sbom_overview=true`
  )
  if (!artifactRes.ok) return null

  const artifact = (await artifactRes.json()) as RawArtifactExtras
  const sbomDigest = artifact.sbom_overview?.sbom_digest
  if (!sbomDigest) return null

  // Straight to the registry API. `repo` already carries the project prefix, which is exactly
  // the path /v2/ wants — no double-encoding here, unlike Harbor's own repository routes.
  const manifestRes = await registryFetch(conn, `/v2/${repo}/manifests/${sbomDigest}`, {
    headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
  })
  if (!manifestRes.ok) return null

  const manifest = (await manifestRes.json()) as { layers?: Array<{ digest: string }> }
  const layer = manifest.layers?.[0]
  if (!layer) return null

  const blobRes = await registryFetch(conn, `/v2/${repo}/blobs/${layer.digest}`)
  if (!blobRes.ok) return null

  const document = (await blobRes.json().catch(() => null)) as Record<string, unknown> | null
  if (!document || typeof document !== "object") return null

  // Trivy under Harbor 2.15 emits SPDX, not the CycloneDX the docs imply, so the format is
  // read off the document rather than assumed — the file is named after what it is.
  const format =
    "SPDXID" in document || "spdxVersion" in document
      ? "spdx"
      : document.bomFormat === "CycloneDX"
        ? "cyclonedx"
        : "json"

  return { document, format }
}


/**
 * Harbor gained `auto_sbom_generation` in 2.12. An older instance validates metadata keys
 * against a whitelist and rejects the whole PUT on an unknown one, so the key has to be left
 * out entirely rather than sent as "false" — which is why this is a version question and not
 * an error-handling one.
 *
 * Unreadable version (an anonymous /systeminfo, an unreachable member) answers `false`: the
 * safe reading is "do not send the key", which costs a feature rather than a failed write.
 */
export function harborSupportsSbom(version: string | null): boolean {
  const capability = capabilityById("sbom-generation")
  if (!capability) throw new Error("sbom-generation is missing from the Harbor capability catalogue")
  // "unknown" and "unavailable" both answer false here, for the reason above: not being able to
  // tell must cost the SBOM key, not the whole request.
  return capabilityAvailability(capability, parseHarborVersion(version)) === "available"
}

/**
 * Sets the scan-on-push flags on one Harbor project.
 *
 * Only the keys given are sent. Harbor merges project metadata rather than replacing it —
 * verified against 2.15.0 — so a PUT carrying `auto_scan` alone leaves `public` and the
 * storage limit untouched. Sending the full metadata object instead would make this call
 * responsible for every setting it does not own.
 */
export async function setHarborProjectMetadata(
  conn: RegistryConnection,
  projectName: string,
  flags: { autoScan?: boolean; autoSbom?: boolean }
): Promise<void> {
  const metadata: Record<string, string> = {}
  if (flags.autoScan !== undefined) metadata.auto_scan = String(flags.autoScan)
  if (flags.autoSbom !== undefined) metadata.auto_sbom_generation = String(flags.autoSbom)
  if (Object.keys(metadata).length === 0) return

  const res = await registryFetch(conn, `/api/v2.0/projects/${encodeURIComponent(projectName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata }),
  })
  if (!res.ok) throw new Error(`Harbor project metadata update failed (${res.status})`)
}

/** What a manual scan request asks Harbor to produce. */
export type HarborScanType = "vulnerability" | "sbom"

/**
 * Asks Harbor to (re)scan one artifact, or to generate its SBOM.
 *
 * Harbor answers 202 and does the work on its own schedule, so there is nothing to await
 * here beyond the acceptance: the result shows up later in `scan_overview` / `sbom_overview`,
 * which is what the UI polls. Verified against 2.15.0 — an empty body means vulnerabilities,
 * `{"scan_type":"sbom"}` means SBOM.
 */
export async function requestHarborScan(
  conn: RegistryConnection,
  repo: string,
  reference: string,
  scanType: HarborScanType = "vulnerability"
): Promise<void> {
  const { project, repository } = splitHarborRepo(repo)
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeHarborRepository(repository)}/artifacts/${encodeURIComponent(reference)}/scan`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scanType === "sbom" ? { scan_type: "sbom" } : {}),
    }
  )
  // 409 is Harbor saying a scan of this kind is already running — the caller asked for a
  // scan and a scan is happening, so that is the outcome they wanted, not an error.
  if (!res.ok && res.status !== 409) {
    throw new Error(`Harbor scan request failed (${res.status})`)
  }
}

// Parses the numeric ID out of a Harbor `Location: /api/v2.0/<resource>/<id>` response
// header — Harbor's write endpoints return 201 + Location, not a body with the new ID.
function parseIdFromLocation(res: Response): number | null {
  const location = res.headers.get("location")
  if (!location) return null
  const match = /\/(\d+)$/.exec(location)
  return match ? Number(match[1]) : null
}

export async function createHarborProject(
  conn: RegistryConnection,
  projectName: string,
  opts: {
    public?: boolean
    storageLimitBytes?: number | null
    autoScan?: boolean
    autoSbom?: boolean
  } = {}
): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: projectName,
      // The scan flags go in at creation rather than in a follow-up PUT: a project that
      // exists for even a moment without auto_scan can be pushed to in that window, and the
      // image that lands is then the one nobody ever scanned.
      metadata: {
        public: String(opts.public ?? false),
        auto_scan: String(opts.autoScan ?? false),
        ...(opts.autoSbom === undefined ? {} : { auto_sbom_generation: String(opts.autoSbom) }),
      },
      // Harbor's own "no limit" sentinel. Sending it explicitly rather than omitting the
      // field keeps the project off whatever default the instance was configured with.
      storage_limit: opts.storageLimitBytes ?? -1,
    }),
  })
  if (!res.ok) throw new Error(`Harbor project creation failed (${res.status})`)

  const id = parseIdFromLocation(res)
  if (id) return id

  // Fall back to a name lookup if this Harbor version doesn't set Location.
  const lookup = await registryFetch(conn, `/api/v2.0/projects?name=${encodeURIComponent(projectName)}`)
  if (!lookup.ok) throw new Error(`Could not resolve created project "${projectName}"`)
  const projects = (await lookup.json()) as Array<{ project_id: number; name: string }>
  const match = projects.find((p) => p.name === projectName)
  if (!match) throw new Error(`Could not resolve created project "${projectName}"`)
  return match.project_id
}

// Harbor refuses to delete a project that still holds repositories, and answers 412 for it.
// That is a user-fixable state ("empty it first"), not a transport failure worth retrying,
// so it is typed apart from the generic error — see deleteProjectAcrossCluster.
export class HarborProjectNotEmptyError extends Error {
  constructor(message = "Project still contains repositories") {
    super(message)
    this.name = "HarborProjectNotEmptyError"
  }
}

// A 404 is success: the project is already gone, which is exactly the desired end state
// (and what a replayed delete finds after a first attempt got through).
export async function deleteHarborProject(conn: RegistryConnection, projectId: number): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/projects/${projectId}`, { method: "DELETE" })
  if (res.ok || res.status === 404) return
  if (res.status === 412) throw new HarborProjectNotEmptyError()
  throw new Error(`Harbor project deletion failed (${res.status})`)
}

// How many repositories the project holds on this Harbor, or null when it is already gone.
// Used as a pre-flight before a cluster-wide delete: Harbor refuses a non-empty project, and
// discovering that halfway through the fan-out would leave the project deleted on some
// members and alive on the rest.
export async function getHarborProjectRepoCount(
  conn: RegistryConnection,
  harborProjectId: number
): Promise<number | null> {
  const res = await registryFetch(conn, `/api/v2.0/projects/${harborProjectId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Harbor project request failed (${res.status})`)
  const body = (await res.json()) as { repo_count?: number }
  return body.repo_count ?? 0
}

export interface HarborQuota {
  id: number
  /** Harbor's own sentinel for "no limit" is -1, and it is passed through unchanged. */
  hardBytes: number
  usedBytes: number
}

// Harbor creates one quota per project automatically, so this is a lookup and never a
// create. Returns null when the Harbor has no quota for that project — an older 2.x, or a
// project that has just been created and not yet had its quota materialised.
export async function getHarborProjectQuota(
  conn: RegistryConnection,
  harborProjectId: number
): Promise<HarborQuota | null> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/quotas?reference=project&reference_id=${harborProjectId}`
  )
  if (!res.ok) throw new Error(`Harbor quota request failed (${res.status})`)

  const body = (await res.json()) as Array<{
    id: number
    hard?: { storage?: number }
    used?: { storage?: number }
  }>
  const quota = body[0]
  if (!quota) return null

  return {
    id: quota.id,
    hardBytes: quota.hard?.storage ?? -1,
    usedBytes: quota.used?.storage ?? 0,
  }
}

// Harbor answers 422 when the requested limit is below what the project already stores.
// Typed apart for the same reason as HarborProjectNotEmptyError: the member is healthy and
// has made up its mind, so replaying the call later would only block its queue behind an
// operation that can never succeed on its own.
export class HarborQuotaRejectedError extends Error {
  constructor(message = "Quota is below the storage the project already uses") {
    super(message)
    this.name = "HarborQuotaRejectedError"
  }
}

// `hardBytes` of -1 lifts the limit.
export async function setHarborProjectQuota(
  conn: RegistryConnection,
  quotaId: number,
  hardBytes: number
): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/quotas/${quotaId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hard: { storage: hardBytes } }),
  })
  if (res.ok) return
  if (res.status === 422) throw new HarborQuotaRejectedError()
  throw new Error(`Harbor quota update failed (${res.status})`)
}

// Lets a replayed fan-out adopt a project a previous attempt already created instead of
// failing on Harbor's 409 — see src/lib/clusters/queue.ts.
export async function findHarborProjectIdByName(
  conn: RegistryConnection,
  projectName: string
): Promise<number | null> {
  const res = await registryFetch(conn, `/api/v2.0/projects?name=${encodeURIComponent(projectName)}`)
  if (!res.ok) return null
  const projects = (await res.json()) as Array<{ project_id: number; name: string }>
  // Harbor's `name` filter is a substring match, so an exact comparison is still required.
  return projects.find((p) => p.name === projectName)?.project_id ?? null
}

export interface HarborRepositoryHit {
  /** Full catalog name, project prefix included: "team/api". */
  name: string
  projectName: string
  harborProjectId: number
  artifactCount: number
  pullCount: number
}

// Harbor's own cross-project repository search — one call per Harbor instead of listing every
// project's repositories and filtering here. The match is a substring of the full name.
//
// It answers as whoever is calling, which for the Gateway is an administrator: results cover
// every project on that Harbor, so the caller is responsible for keeping only the ones the
// end user may see (see /api/search).
export async function searchHarborRepositories(
  conn: RegistryConnection,
  query: string
): Promise<HarborRepositoryHit[]> {
  const res = await registryFetch(conn, `/api/v2.0/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`Harbor search failed (${res.status})`)
  const body = (await res.json()) as {
    repository?: Array<{
      project_id: number
      project_name: string
      repository_name: string
      artifact_count?: number
      pull_count?: number
    }>
  }
  return (body.repository ?? []).map((r) => ({
    name: r.repository_name,
    projectName: r.project_name,
    harborProjectId: r.project_id,
    artifactCount: r.artifact_count ?? 0,
    pullCount: r.pull_count ?? 0,
  }))
}

export interface HarborDirectoryUser {
  /** Harbor's own numeric user ID — informative; membership is granted by username. */
  userId: number
  username: string
}

// The cluster's user directory, as Harbor sees it — whatever backs it (its own database, an
// LDAP, an OIDC provider). This is what a cluster with a directory of its own has to be asked
// before a membership can name anybody there: an identifier typed from memory is exactly how
// a homonym in another directory ends up receiving somebody else's access.
//
// /users/search is readable by any authenticated Harbor user (unlike /users, which is admin
// only) and returns username and ID, nothing more — which is all that is needed here.
//
// Two measured quirks of that endpoint: the match is a *case-sensitive* substring ("CLEM"
// finds nothing when the account is "clement"), and Harbor never returns its own `admin`
// account. Both only matter to callers that read an empty result as "no such account".
export async function searchHarborUsers(
  conn: RegistryConnection,
  query: string,
  pageSize = 25
): Promise<HarborDirectoryUser[]> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/users/search?username=${encodeURIComponent(query)}&page_size=${pageSize}`
  )
  if (!res.ok) throw new Error(`Harbor user search failed (${res.status})`)
  const body = (await res.json()) as Array<{ user_id: number; username: string }>
  return body.map((u) => ({ userId: u.user_id, username: u.username }))
}

// Harbor's built-in project roles, by the numeric IDs its member API speaks. Only the three
// the Gateway exposes are listed; Harbor also knows 4 (maintainer) and 5 (limited guest).
export const HARBOR_ROLE_PROJECT_ADMIN = 1
export const HARBOR_ROLE_DEVELOPER = 2
export const HARBOR_ROLE_GUEST = 3

export interface HarborProjectMember {
  /** Harbor's member ID — scoped to the project, not the user. */
  id: number
  entityName: string
  roleId: number
}

// Harbor refuses a member whose username it doesn't know: with database auth the account has
// to have been created there first, and with LDAP it has to be resolvable in the directory.
// Typed apart for the same reason as HarborQuotaRejectedError — the member is healthy and has
// made up its mind, so replaying would only block its queue behind a call that cannot succeed
// until somebody provisions the user.
//
// Why it doesn't know them depends on what backs that Harbor, and the three answers call for
// three different fixes — measured on 2.15.0 (docs/plan-ldap-sso-local.md, lot 0b): an
// LDAP-backed Harbor creates a directory account on the spot when it is granted, so a refusal
// there means the directory has no such account; an OIDC-backed one cannot create anybody
// ahead of their first sign-in; a database-backed one only knows the accounts created in it.
export type HarborUnknownUserReason = "absent-from-directory" | "not-yet-signed-in" | "no-local-account"

const UNKNOWN_USER_EXPLANATION: Record<HarborUnknownUserReason, string> = {
  "absent-from-directory": "its LDAP directory has no such account",
  "not-yet-signed-in":
    "it signs people in through OIDC and only learns an account at that person's first sign-in to Harbor",
  "no-local-account": "it uses its own database accounts, and nobody has created this one there",
}

export class HarborUnknownUserError extends Error {
  constructor(username: string, registryName?: string, readonly reason?: HarborUnknownUserReason) {
    super(
      `${registryName ? `${registryName} has no user` : "Harbor has no user"} "${username}"` +
        (reason ? ` — ${UNKNOWN_USER_EXPLANATION[reason]}` : "")
    )
    this.name = "HarborUnknownUserError"
  }
}

// Harbor's `entityname` filter is a substring match (same as the project `name` one), so the
// exact comparison still has to happen here.
export async function findHarborProjectMember(
  conn: RegistryConnection,
  harborProjectId: number,
  username: string
): Promise<HarborProjectMember | null> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${harborProjectId}/members?entityname=${encodeURIComponent(username)}&page_size=100`
  )
  if (!res.ok) return null

  const members = (await res.json()) as Array<{
    id: number
    entity_name?: string
    entity_type?: string
    role_id?: number
  }>
  const match = members.find(
    (m) => m.entity_type !== "g" && m.entity_name?.toLowerCase() === username.toLowerCase()
  )
  return match ? { id: match.id, entityName: match.entity_name!, roleId: match.role_id ?? 0 } : null
}

/**
 * Grants `username` `roleId` on the project, whether or not they are already a member.
 *
 * Written to be repeatable, like the rest of the fan-out: an existing membership has its role
 * PUT to the desired one rather than being left as it was, so replaying a role change
 * converges instead of silently keeping the old grant.
 */
export async function applyHarborProjectMember(
  conn: RegistryConnection,
  harborProjectId: number,
  username: string,
  roleId: number
): Promise<number> {
  const existing = await findHarborProjectMember(conn, harborProjectId, username)
  if (existing) {
    if (existing.roleId !== roleId) {
      await setHarborProjectMemberRole(conn, harborProjectId, existing.id, roleId)
    }
    return existing.id
  }

  const res = await registryFetch(conn, `/api/v2.0/projects/${harborProjectId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_id: roleId, member_user: { username } }),
  })

  if (res.ok) {
    const id = parseIdFromLocation(res)
    if (id) return id
    // Harbor versions that don't set Location leave a name lookup as the only way back to it.
    const created = await findHarborProjectMember(conn, harborProjectId, username)
    if (created) return created.id
    throw new Error(`Could not resolve the membership just created for "${username}"`)
  }

  // 409 means somebody (or a previous attempt) added them between the lookup and here —
  // the desired state, so it is read back rather than treated as a failure.
  if (res.status === 409) {
    const created = await findHarborProjectMember(conn, harborProjectId, username)
    if (created) {
      if (created.roleId !== roleId) {
        await setHarborProjectMemberRole(conn, harborProjectId, created.id, roleId)
      }
      return created.id
    }
  }

  // Harbor answers 404 for an unknown user, and 400 for one it cannot resolve in the
  // configured auth backend — both mean "provision this account first", not "retry later".
  if (res.status === 404 || res.status === 400) throw new HarborUnknownUserError(username)

  throw new Error(`Harbor project member creation failed (${res.status})`)
}

export async function setHarborProjectMemberRole(
  conn: RegistryConnection,
  harborProjectId: number,
  memberId: number,
  roleId: number
): Promise<void> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${harborProjectId}/members/${memberId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: roleId }),
    }
  )
  if (!res.ok) throw new Error(`Harbor project member role update failed (${res.status})`)
}

// A 404 is success: the membership is already gone, which is the desired end state (and what
// a replayed removal finds after a first attempt got through).
export async function removeHarborProjectMember(
  conn: RegistryConnection,
  harborProjectId: number,
  memberId: number
): Promise<void> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${harborProjectId}/members/${memberId}`,
    { method: "DELETE" }
  )
  if (!res.ok && res.status !== 404) {
    throw new Error(`Harbor project member removal failed (${res.status})`)
  }
}

export interface HarborUserGroup {
  id: number
  name: string
  /** Harbor's own encoding: 1 = LDAP, 2 = HTTP, 3 = OIDC. */
  type: number
}

// The groups the cluster's Harbor knows — LDAP groups on an LDAP-backed Harbor, OIDC groups
// on an OIDC-backed one. Granting a whole group is the alternative to mapping every person of
// a team one by one; see ProjectGroupMember in the Prisma schema for what that costs.
//
// Only groups Harbor already holds are offered. Harbor *can* register an LDAP group on the
// fly from a DN, but a DN typed into a form is unverifiable — the same objection as typing a
// username — so the Gateway never creates one.
export async function listHarborUserGroups(
  conn: RegistryConnection,
  query?: string
): Promise<HarborUserGroup[]> {
  const res = await registryFetch(conn, "/api/v2.0/usergroups?page_size=100")
  if (!res.ok) throw new Error(`Harbor user group request failed (${res.status})`)
  const body = (await res.json()) as Array<{
    id: number
    group_name: string
    group_type: number
  }>
  const needle = query?.trim().toLowerCase()
  return body
    .map((g) => ({ id: g.id, name: g.group_name, type: g.group_type }))
    .filter((g) => !needle || g.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Same shape as HarborUnknownUserError, and typed apart for the same reason: a group Harbor
// does not hold cannot be granted, and replaying would never change that.
export class HarborUnknownGroupError extends Error {
  constructor(groupName: string, registryName?: string) {
    super(
      registryName
        ? `${registryName} has no group "${groupName}"`
        : `Harbor has no group "${groupName}"`
    )
    this.name = "HarborUnknownGroupError"
  }
}

// The group half of findHarborProjectMember — same substring caveat on Harbor's filter, and
// the mirror-image entity_type test.
export async function findHarborProjectGroupMember(
  conn: RegistryConnection,
  harborProjectId: number,
  groupName: string
): Promise<HarborProjectMember | null> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/projects/${harborProjectId}/members?entityname=${encodeURIComponent(groupName)}&page_size=100`
  )
  if (!res.ok) return null

  const members = (await res.json()) as Array<{
    id: number
    entity_name?: string
    entity_type?: string
    role_id?: number
  }>
  const match = members.find(
    (m) => m.entity_type === "g" && m.entity_name?.toLowerCase() === groupName.toLowerCase()
  )
  return match ? { id: match.id, entityName: match.entity_name!, roleId: match.role_id ?? 0 } : null
}

/**
 * Grants `groupName` `roleId` on the project, whether or not it is already a member.
 *
 * The group is addressed by its Harbor ID rather than by name: `member_group` accepts a name
 * plus a DN and would *create* the group when it doesn't match one, which is exactly the
 * unverifiable write listHarborUserGroups avoids.
 */
export async function applyHarborProjectGroupMember(
  conn: RegistryConnection,
  harborProjectId: number,
  groupName: string,
  roleId: number
): Promise<number> {
  const existing = await findHarborProjectGroupMember(conn, harborProjectId, groupName)
  if (existing) {
    if (existing.roleId !== roleId) {
      await setHarborProjectMemberRole(conn, harborProjectId, existing.id, roleId)
    }
    return existing.id
  }

  const groups = await listHarborUserGroups(conn, groupName)
  const group = groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase())
  if (!group) throw new HarborUnknownGroupError(groupName)

  const res = await registryFetch(conn, `/api/v2.0/projects/${harborProjectId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_id: roleId, member_group: { id: group.id } }),
  })

  if (res.ok) {
    const id = parseIdFromLocation(res)
    if (id) return id
    const created = await findHarborProjectGroupMember(conn, harborProjectId, groupName)
    if (created) return created.id
    throw new Error(`Could not resolve the membership just created for group "${groupName}"`)
  }

  // Same race as the user path: somebody added it between the lookup and here.
  if (res.status === 409) {
    const created = await findHarborProjectGroupMember(conn, harborProjectId, groupName)
    if (created) {
      if (created.roleId !== roleId) {
        await setHarborProjectMemberRole(conn, harborProjectId, created.id, roleId)
      }
      return created.id
    }
  }

  if (res.status === 404 || res.status === 400) throw new HarborUnknownGroupError(groupName)

  throw new Error(`Harbor project group member creation failed (${res.status})`)
}

// ---------------------------------------------------------------------------------------------
// The LDAP directory, read through Harbor
// ---------------------------------------------------------------------------------------------
//
// The Gateway holds no LDAP client (docs/plan-ldap-sso-local.md, D3). Every lookup below asks a
// Harbor to query the directory *it* is configured with — base DN, filter, bind account, CA — so
// the Gateway can never offer an account that this Harbor would then refuse. None of the
// behaviours noted here is in the spec; they were measured on Harbor 2.15.0 on 2026-09-10
// (same plan, lot 0b).

/** Harbor's `auth_mode`. Other values exist (http_auth, uaa_auth) and are passed through as-is. */
export type HarborAuthMode = "db_auth" | "ldap_auth" | "oidc_auth" | (string & {})

/** The LDAP settings a Harbor carries — minus its bind password, which the API never returns. */
export interface HarborLdapSettings {
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
  groupSearchScope: number | null
}

export interface HarborAuthConfig {
  authMode: HarborAuthMode
  /** Harbor freezes auth_mode once it holds a non-admin account; null when it did not say. */
  authModeEditable: boolean | null
  ldap: HarborLdapSettings
}

/**
 * How a configuration or directory call was refused. Typed rather than folded into one message:
 * "not an administrator" is fixed by an operator in the registry form, "the directory did not
 * answer" by whoever runs the LDAP server, and the two must not read the same.
 */
export type HarborDirectoryFailure = "forbidden" | "bad-request" | "directory-error" | "unexpected"

export class HarborDirectoryError extends Error {
  constructor(
    readonly failure: HarborDirectoryFailure,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "HarborDirectoryError"
  }
}

function directoryError(status: number, what: string): HarborDirectoryError {
  if (status === 401 || status === 403) {
    return new HarborDirectoryError(
      "forbidden",
      status,
      `${what} was refused (${status}): the credentials stored for this Harbor are not a Harbor administrator`
    )
  }
  if (status === 400) {
    return new HarborDirectoryError("bad-request", status, `${what} was rejected (400) by Harbor`)
  }
  // Measured: a wrong bind password, an unreachable LDAP server and a base DN that does not
  // exist all come back as the same bodiless 500. Harbor says nothing more, so neither can we.
  if (status >= 500) {
    return new HarborDirectoryError(
      "directory-error",
      status,
      `${what} failed (${status}): Harbor could not query its LDAP directory — a wrong bind password, an unreachable server or a missing base DN`
    )
  }
  return new HarborDirectoryError("unexpected", status, `${what} failed (${status})`)
}

/** The first `errors[].message` of a Harbor error body, when there is one. */
async function harborErrorMessage(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: unknown }> } | null
  const message = body?.errors?.[0]?.message
  return typeof message === "string" ? message : null
}

/**
 * Reads how this Harbor authenticates people and which directory it is configured with.
 *
 * Built field by field on purpose: /configurations also carries OIDC and UAA settings, and
 * nothing this function was not written to return reaches its caller.
 */
export async function getHarborAuthConfig(conn: RegistryConnection): Promise<HarborAuthConfig> {
  const res = await registryFetch(conn, "/api/v2.0/configurations")
  if (!res.ok) throw directoryError(res.status, "Reading the Harbor configuration")

  const body = (await res.json()) as Record<string, { value?: unknown; editable?: unknown } | undefined>
  const text = (key: string) => {
    const value = body[key]?.value
    return typeof value === "string" ? value : ""
  }
  const number = (key: string) => {
    const value = body[key]?.value
    return typeof value === "number" ? value : null
  }
  const flag = (key: string) => {
    const value = body[key]?.value
    return typeof value === "boolean" ? value : null
  }
  const editable = body.auth_mode?.editable

  return {
    authMode: text("auth_mode"),
    authModeEditable: typeof editable === "boolean" ? editable : null,
    ldap: {
      url: text("ldap_url"),
      searchDn: text("ldap_search_dn"),
      baseDn: text("ldap_base_dn"),
      filter: text("ldap_filter"),
      uid: text("ldap_uid"),
      scope: number("ldap_scope"),
      verifyCert: flag("ldap_verify_cert"),
      groupBaseDn: text("ldap_group_base_dn"),
      groupSearchFilter: text("ldap_group_search_filter"),
      groupAttributeName: text("ldap_group_attribute_name"),
      groupMembershipAttribute: text("ldap_group_membership_attribute"),
      groupSearchScope: number("ldap_group_search_scope"),
    },
  }
}

export interface HarborLdapUser {
  username: string
  realname: string | null
  email: string | null
}

/**
 * Looks an account up in this Harbor's LDAP directory — including accounts that never signed in
 * to Harbor, which is the whole difference with searchHarborUsers().
 *
 * Two measured properties shape the callers: the match is **exact** on the uid attribute (`al`
 * and `al*` find nothing when the account is `alice`), and an **empty** query returns the entire
 * directory. The second is why an empty query never leaves this function.
 *
 * Answers from the stored `ldap_*` settings whatever the Harbor's auth_mode — db_auth and
 * oidc_auth included (measured, M1).
 */
export async function searchLdapUsers(
  conn: RegistryConnection,
  username: string
): Promise<HarborLdapUser[]> {
  const query = username.trim()
  if (!query) return []

  const res = await registryFetch(
    conn,
    `/api/v2.0/ldap/users/search?username=${encodeURIComponent(query)}`
  )
  if (!res.ok) throw directoryError(res.status, "The directory search")

  const body = (await res.json()) as Array<{ username?: unknown; realname?: unknown; email?: unknown }>
  return body
    .filter((u): u is { username: string; realname?: unknown; email?: unknown } =>
      typeof u.username === "string" && u.username !== ""
    )
    .map((u) => ({
      username: u.username,
      realname: typeof u.realname === "string" && u.realname ? u.realname : null,
      email: typeof u.email === "string" && u.email ? u.email : null,
    }))
}

export interface HarborLdapGroup {
  name: string
  /** Read from the directory, so verified — unlike a DN typed into a form. */
  dn: string
}

/** Exact lookup of a directory group, by name or by DN. Same empty-query rule as users. */
export async function searchLdapGroups(
  conn: RegistryConnection,
  by: { name: string } | { dn: string }
): Promise<HarborLdapGroup[]> {
  const [param, raw] = "dn" in by ? ["groupdn", by.dn] : ["groupname", by.name]
  const value = raw.trim()
  if (!value) return []

  const res = await registryFetch(
    conn,
    `/api/v2.0/ldap/groups/search?${param}=${encodeURIComponent(value)}`
  )
  // Unlike the user search, "no such group" is a 404 here rather than an empty list (measured).
  if (res.status === 404) return []
  if (!res.ok) throw directoryError(res.status, "The directory group search")

  const body = (await res.json()) as Array<{ group_name?: unknown; ldap_group_dn?: unknown }>
  return body
    .filter((g): g is { group_name: string; ldap_group_dn: string } =>
      typeof g.group_name === "string" && typeof g.ldap_group_dn === "string" && g.ldap_group_dn !== ""
    )
    .map((g) => ({ name: g.group_name, dn: g.ldap_group_dn }))
}

export interface LdapImportOutcome {
  imported: string[]
  /** One entry per refused uid, with Harbor's own reason ("unknown_user", …). */
  failed: Array<{ uid: string; error: string }>
}

/**
 * Creates Harbor accounts for directory uids, ahead of any sign-in.
 *
 * Idempotent on an uid already imported (measured, M2). But Harbor refuses the **whole** batch
 * when one uid is refused — the others are not imported either — so the batch is sent again
 * without the uids it named. A failure is thereby attributed to the uid that caused it, never to
 * its neighbours, the same rule replication.ts applies to the edge that failed.
 *
 * Only an LDAP-backed Harbor imports anybody: db_auth and oidc_auth refuse every uid with
 * "failed to import user" (measured).
 */
export async function importLdapUsers(
  conn: RegistryConnection,
  uids: string[]
): Promise<LdapImportOutcome> {
  let pending = [...new Set(uids.map((uid) => uid.trim()).filter(Boolean))]
  const failed: LdapImportOutcome["failed"] = []

  // Two passes at most: the first names the uids Harbor refuses, the second imports the rest.
  // A refusal on the second pass would mean Harbor changed its mind about uids it had not
  // complained about; that is reported, never looped on.
  for (let pass = 0; pass < 2 && pending.length > 0; pass++) {
    const res = await registryFetch(conn, "/api/v2.0/ldap/users/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ldap_uid_list: pending }),
    })
    if (res.ok) return { imported: pending, failed }
    if (res.status !== 404) throw directoryError(res.status, "The directory import")

    const body = (await res.json().catch(() => null)) as Array<{ uid?: unknown; error?: unknown }> | null
    const refused = new Map<string, string>()
    for (const entry of Array.isArray(body) ? body : []) {
      if (typeof entry.uid === "string") {
        refused.set(entry.uid.toLowerCase(), typeof entry.error === "string" ? entry.error : "refused")
      }
    }

    const named = pending.filter((uid) => refused.has(uid.toLowerCase()))
    // A 404 that names none of ours cannot be attributed to anybody in particular.
    if (named.length === 0) {
      return {
        imported: [],
        failed: [...failed, ...pending.map((uid) => ({ uid, error: "refused by Harbor without a reason" }))],
      }
    }
    for (const uid of named) failed.push({ uid, error: refused.get(uid.toLowerCase())! })
    pending = pending.filter((uid) => !refused.has(uid.toLowerCase()))

    if (pass === 1) {
      return {
        imported: [],
        failed: [...failed, ...pending.map((uid) => ({ uid, error: "not imported: Harbor refused the batch again" }))],
      }
    }
  }

  return { imported: [], failed }
}

/**
 * Registers an LDAP group on this Harbor from a DN read out of its directory, and returns its ID.
 * An already registered group (409) is the desired state and is read back.
 */
export async function registerHarborLdapGroup(
  conn: RegistryConnection,
  groupName: string,
  dn: string
): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/usergroups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_name: groupName, group_type: 1, ldap_group_dn: dn }),
  })

  if (res.ok || res.status === 409) {
    const id = res.ok ? parseIdFromLocation(res) : null
    if (id) return id
    const groups = await listHarborUserGroups(conn, groupName)
    const match = groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase())
    if (match) return match.id
    throw new Error(`Could not resolve the group "${groupName}" just registered`)
  }
  throw directoryError(res.status, "Registering the LDAP group")
}

/** The LDAP settings to test or write — the bind password included, since Harbor never reuses the stored one. */
export interface HarborLdapCandidate {
  url: string
  searchDn: string
  searchPassword: string
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

/**
 * Asks this Harbor whether it can reach and bind to a *candidate* directory.
 *
 * It tests only the body it is sent: without a password it answers "error: empty password"
 * rather than reusing the stored one (measured). It is therefore a check of settings about to be
 * written, never a health check of the ones in place — for that, see clusters/directory-view.ts.
 * Always 200: the verdict is in the body.
 */
export async function pingHarborLdap(
  conn: RegistryConnection,
  candidate: HarborLdapCandidate
): Promise<{ success: boolean; message: string | null }> {
  const res = await registryFetch(conn, "/api/v2.0/ldap/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ldap_url: candidate.url,
      ldap_search_dn: candidate.searchDn,
      ldap_search_password: candidate.searchPassword,
      ldap_base_dn: candidate.baseDn,
      ldap_filter: candidate.filter,
      ldap_uid: candidate.uid,
      ldap_scope: candidate.scope,
      ldap_verify_cert: candidate.verifyCert,
    }),
  })
  if (!res.ok) throw directoryError(res.status, "The directory ping")

  const body = (await res.json().catch(() => null)) as { success?: unknown; message?: unknown } | null
  return {
    success: body?.success === true,
    message: typeof body?.message === "string" ? body.message : null,
  }
}

/**
 * Writes the LDAP settings of this Harbor. auth_mode is deliberately not part of it: Harbor
 * rejects the *entire* PUT when auth_mode is frozen (measured), which would silently drop the
 * directory settings along with it. See setHarborAuthMode().
 */
export async function putHarborLdapConfig(
  conn: RegistryConnection,
  candidate: HarborLdapCandidate
): Promise<void> {
  const res = await registryFetch(conn, "/api/v2.0/configurations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ldap_url: candidate.url,
      ldap_search_dn: candidate.searchDn,
      ldap_search_password: candidate.searchPassword,
      ldap_base_dn: candidate.baseDn,
      ldap_filter: candidate.filter,
      ldap_uid: candidate.uid,
      ldap_scope: candidate.scope,
      ldap_verify_cert: candidate.verifyCert,
      ldap_group_base_dn: candidate.groupBaseDn,
      ldap_group_search_filter: candidate.groupSearchFilter,
      ldap_group_attribute_name: candidate.groupAttributeName,
      ldap_group_membership_attribute: candidate.groupMembershipAttribute,
      ldap_group_search_scope: candidate.groupSearchScope,
    }),
  })
  if (res.ok) return
  const message = await harborErrorMessage(res)
  const error = directoryError(res.status, "Writing the LDAP configuration")
  if (message) error.message = `${error.message}: ${message}`
  throw error
}

/**
 * Switches this Harbor's auth_mode. Harbor refuses it as soon as one non-admin account exists
 * ("the auth mode cannot be modified as new users have been inserted into database", measured,
 * M4) — which is what confines this to adopting a blank Harbor.
 */
export async function setHarborAuthMode(conn: RegistryConnection, authMode: HarborAuthMode): Promise<void> {
  const res = await registryFetch(conn, "/api/v2.0/configurations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth_mode: authMode }),
  })
  if (res.ok) return
  const message = await harborErrorMessage(res)
  const error = directoryError(res.status, "Changing the Harbor auth mode")
  if (message) error.message = `${error.message}: ${message}`
  throw error
}

/**
 * How many accounts other than `admin` this Harbor holds — the number that freezes auth_mode.
 * /users never lists `admin` itself (measured), so its total is exactly that count.
 */
export async function countHarborUsers(conn: RegistryConnection): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/users?page_size=1")
  if (!res.ok) throw directoryError(res.status, "Counting the Harbor accounts")
  const total = Number(res.headers.get("x-total-count"))
  if (Number.isFinite(total)) return total
  const body = (await res.json().catch(() => [])) as unknown[]
  return Array.isArray(body) ? body.length : 0
}

export interface HarborRobotPermission {
  resource: string
  action: string
}

// A reasonable default permission set for a project robot account — covers push/pull plus
// tag and artifact management. Not exposed as granular UI controls in v1.
export const DEFAULT_ROBOT_PERMISSIONS: HarborRobotPermission[] = [
  { resource: "repository", action: "pull" },
  { resource: "repository", action: "push" },
  { resource: "artifact", action: "read" },
  { resource: "artifact", action: "list" },
  { resource: "artifact", action: "delete" },
  { resource: "tag", action: "create" },
  { resource: "tag", action: "delete" },
  { resource: "tag", action: "list" },
  // Triggering a scan or an SBOM generation. Robots created before this was added do not
  // carry it; the reconciler re-provisions them on the next fan-out over their cluster.
  { resource: "scan", action: "create" },
]

export interface CreatedHarborRobot {
  id: number
  name: string
  secret: string
}

export async function createHarborRobotAccount(
  conn: RegistryConnection,
  projectName: string,
  name: string,
  opts: { description?: string; expiresInDays?: number; permissions?: HarborRobotPermission[] } = {}
): Promise<CreatedHarborRobot> {
  const res = await registryFetch(conn, "/api/v2.0/robots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: opts.description ?? "",
      duration: opts.expiresInDays ?? -1,
      level: "project",
      permissions: [
        {
          kind: "project",
          namespace: projectName,
          access: opts.permissions ?? DEFAULT_ROBOT_PERMISSIONS,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Harbor robot account creation failed (${res.status})`)

  const body = (await res.json()) as { id: number; name: string; secret: string }
  return { id: body.id, name: body.name, secret: body.secret }
}

export async function deleteHarborRobotAccount(conn: RegistryConnection, robotId: number): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/robots/${robotId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 404) throw new Error(`Harbor robot deletion failed (${res.status})`)
}

// Harbor stores project robots under the generated name `robot$<project>+<name>`, and the
// `q=` filter matches on that full string rather than the short name the caller supplied.
// Listing and comparing the suffix is the portable way to find one across 2.x versions.
/**
 * The Harbor ID of a project-level robot, or null when that Harbor has none by this name.
 *
 * Listing project robots is not a plain GET: Harbor answers "must with project ID when to
 * query project robots" unless the `q` filter carries both `Level=project` and the numeric
 * `ProjectID` — which is why the project has to be resolved first. A bare
 * `/robots?level=project` (level is not a real query parameter) silently returns the empty
 * system-level list, so this used to report "no such robot" for robots that plainly existed.
 */
export async function findHarborRobotIdByName(
  conn: RegistryConnection,
  projectName: string,
  name: string
): Promise<number | null> {
  const projectId = await findHarborProjectIdByName(conn, projectName)
  if (projectId === null) return null

  const query = encodeURIComponent(`Level=project,ProjectID=${projectId}`)
  const res = await registryFetch(conn, `/api/v2.0/robots?page_size=100&q=${query}`)
  if (!res.ok) return null

  const robots = (await res.json()) as Array<{ id: number; name: string }>
  // Harbor prefixes the stored name: "robot$<project>+<name>".
  return robots.find((r) => r.name.endsWith(`+${name}`))?.id ?? null
}

// Push/pull on every project, plus the artifact and tag verbs the mirror jobs need. Kept
// narrower than Harbor's admin account on purpose: this is the credential that leaves the
// Gateway for a skopeo pod, so it must not be able to reconfigure the Harbor it runs against.
export const SYSTEM_ROBOT_PERMISSIONS: HarborRobotPermission[] = DEFAULT_ROBOT_PERMISSIONS

// Granted at Harbor's *system* scope rather than on `namespace: "*"`, which only ever spans
// projects that already exist. Two things the Gateway's robot does need it for: a replication
// policy pushing into a peer that does not carry the project yet (the endpoint credentials are
// what creates the namespace there), and, by the same token, a first transfer into a delivery
// project. Robots provisioned before this was added lack it; they are re-provisioned rather
// than patched, like every other robot drift.
export const SYSTEM_ROBOT_SYSTEM_SCOPE_PERMISSIONS: HarborRobotPermission[] = [
  { resource: "project", action: "create" },
]

/**
 * Creates the system-level robot that can push into every project of this Harbor.
 *
 * `namespace: "*"` is what makes it system-wide — a project-level robot (see
 * createHarborRobotAccount) is scoped to the one project named there. Harbor returns the
 * generated full name ("robot$<name>" under the default prefix, which is a Harbor setting
 * and not ours to assume), and that is what has to be used as the login.
 */
export async function createHarborSystemRobot(
  conn: RegistryConnection,
  name: string,
  opts: { description?: string; expiresInDays?: number } = {}
): Promise<CreatedHarborRobot> {
  const res = await registryFetch(conn, "/api/v2.0/robots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: opts.description ?? "Managed by Tessark Gateway",
      duration: opts.expiresInDays ?? -1,
      level: "system",
      permissions: [
        { kind: "system", namespace: "/", access: SYSTEM_ROBOT_SYSTEM_SCOPE_PERMISSIONS },
        { kind: "project", namespace: "*", access: SYSTEM_ROBOT_PERMISSIONS },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`Harbor system robot creation failed (${res.status})`)
  }

  const body = (await res.json()) as { id: number; name: string; secret: string }
  return { id: body.id, name: body.name, secret: body.secret }
}

/**
 * The system robot Harbor already knows by this short name, or null.
 *
 * Unlike project robots, system robots are the default page of `/robots` — no `q` filter is
 * required, and `Level=system` is accepted. The stored name carries a prefix Harbor chose
 * ("robot$" by default, configurable), so the match is on the suffix rather than equality.
 */
export async function findHarborSystemRobot(
  conn: RegistryConnection,
  name: string
): Promise<{ id: number; name: string } | null> {
  const query = encodeURIComponent("Level=system")
  const res = await registryFetch(conn, `/api/v2.0/robots?page_size=100&q=${query}`)
  if (!res.ok) return null

  const robots = (await res.json()) as Array<{ id: number; name: string }>
  const found = robots.find((r) => r.name === name || r.name.endsWith(name))
  return found ? { id: found.id, name: found.name } : null
}

// Replaces a robot's secret with one we choose. Harbor mints a different secret on every
// instance, so without this a cluster-wide robot would need one credential per member;
// aligning them here is what lets a single stored secret authenticate against the whole
// cluster. Returns false when the Harbor rejects the call, so the caller can fall back to
// storing that member's own secret (see src/lib/clusters/robots.ts).
export async function setHarborRobotSecret(
  conn: RegistryConnection,
  robotId: number,
  secret: string
): Promise<boolean> {
  const res = await registryFetch(conn, `/api/v2.0/robots/${robotId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  })
  return res.ok
}

function retentionPolicyBody(projectId: number, keepLastN: number, tagPattern: string) {
  return {
    algorithm: "or",
    rules: [
      {
        disabled: false,
        action: "retain",
        template: "latestPushedK",
        params: { latestPushedK: keepLastN },
        tag_selectors: [{ kind: "doublestar", decoration: "matches", pattern: tagPattern }],
        scope_selectors: {
          repository: [{ kind: "doublestar", decoration: "repoMatches", pattern: "**" }],
        },
      },
    ],
    trigger: { kind: "Schedule", settings: { cron: "" }, references: {} },
    scope: { level: "project", ref: projectId },
  }
}

export async function createHarborRetentionPolicy(
  conn: RegistryConnection,
  projectId: number,
  keepLastN: number,
  tagPattern: string
): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/retentions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(retentionPolicyBody(projectId, keepLastN, tagPattern)),
  })
  if (!res.ok) throw new Error(`Harbor retention policy creation failed (${res.status})`)

  const id = parseIdFromLocation(res)
  if (!id) throw new Error("Harbor did not return a retention policy ID")
  return id
}

export async function updateHarborRetentionPolicy(
  conn: RegistryConnection,
  retentionId: number,
  projectId: number,
  keepLastN: number,
  tagPattern: string
): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/retentions/${retentionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(retentionPolicyBody(projectId, keepLastN, tagPattern)),
  })
  if (!res.ok) throw new Error(`Harbor retention policy update failed (${res.status})`)
}

// --- Replication -----------------------------------------------------------------------
//
// Keeping cluster members in sync is Harbor's own job, not the Gateway's: we only wire it
// up. Each direction of the mesh needs two objects on the *source* Harbor — a "registry
// endpoint" describing the peer, and a replication policy pushing to that endpoint.

export interface HarborEndpointInput {
  name: string
  url: string
  username: string | null
  secret: string | null
  insecure: boolean
  /**
   * Harbor's adapter for the far side. "harbor" for a peer of the mesh, "docker-hub" for
   * Docker Hub (whose API is not a plain v2 registry), "docker-registry" for anything else
   * that speaks the v2 API. Defaults to "harbor" so the mesh keeps the endpoints it has.
   */
  type?: string
  description?: string
}

export async function createHarborRegistryEndpoint(
  conn: RegistryConnection,
  input: HarborEndpointInput
): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/registries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      type: input.type ?? "harbor",
      url: input.url,
      description: input.description ?? "Managed by Tessark Gateway — cluster replication peer.",
      insecure: input.insecure,
      credential: input.username
        ? { type: "basic", access_key: input.username, access_secret: input.secret ?? "" }
        : undefined,
    }),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`Harbor registry endpoint creation failed (${res.status})`)
  }

  const id = res.ok ? parseIdFromLocation(res) : null
  if (id) return id

  // 409 means a previous attempt already created it, and some versions omit Location.
  const existing = await findHarborRegistryEndpointIdByName(conn, input.name)
  if (!existing) throw new Error(`Could not resolve registry endpoint "${input.name}"`)
  if (!await updateHarborRegistryEndpoint(conn, existing, input)) throw new Error("Adopted Harbor endpoint disappeared during repair")
  return existing
}

// Paginated rather than a single page_size=100 read: this is the fallback path taken after a
// 409, so returning null here does not mean "no such endpoint" but "endpoint creation now
// fails permanently". A Harbor carrying more than one page of endpoints — one per peer, per
// mirror, plus whatever its admins added — would otherwise never resolve its own.
export async function findHarborRegistryEndpointIdByName(
  conn: RegistryConnection,
  name: string
): Promise<number | null> {
  const pageSize = 100
  for (let page = 1; ; page += 1) {
    const res = await registryFetch(conn, `/api/v2.0/registries?page=${page}&page_size=${pageSize}`)
    if (!res.ok) return null
    const endpoints = (await res.json()) as Array<{ id: number; name: string }>
    const found = endpoints.find((e) => e.name === name)
    if (found) return found.id
    // A short page is the last one. Harbor also answers an empty array past the end, which
    // this covers too.
    if (endpoints.length < pageSize) return null
  }
}

/**
 * Rewrites an endpoint in place — the peer's URL, its credentials, its TLS posture.
 *
 * Without this the mesh is write-once: createHarborRegistryEndpoint answers a 409 with the id
 * of what is already there, so a peer whose password was rotated keeps authenticating with
 * the old one on every other member, the ReplicationLink rows stay ACTIVE, and the only trace
 * is a failing execution in Harbor's own log. Returns false on 404 so the caller can fall
 * back to creating it.
 */
// Numeric IDs may be reused after a Harbor rebuild. Check ownership before a write;
// a reused ID must never overwrite or delete an unrelated administrator's object.
export async function harborObjectMatches(conn: RegistryConnection, path: string, name: string): Promise<boolean> {
  const res = await registryFetch(conn, path)
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Harbor object ownership check failed (${res.status})`)
  const object = await res.json() as { name?: string }
  if (object.name !== name) throw new Error(`Harbor object at ${path} no longer belongs to ${name}`)
  return true
}

export async function updateHarborRegistryEndpoint(
  conn: RegistryConnection,
  id: number,
  input: HarborEndpointInput
): Promise<boolean> {
  if (!await harborObjectMatches(conn, `/api/v2.0/registries/${id}`, input.name)) return false
  const res = await registryFetch(conn, `/api/v2.0/registries/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      type: input.type ?? "harbor",
      url: input.url,
      description: input.description ?? "Managed by Tessark Gateway — cluster replication peer.",
      insecure: input.insecure,
      credential: input.username
        ? { type: "basic", access_key: input.username, access_secret: input.secret ?? "" }
        : undefined,
    }),
  })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Harbor registry endpoint update failed (${res.status})`)
  return true
}

/**
 * Asks the source Harbor whether it can actually reach this endpoint.
 *
 * The Gateway reaching two Harbors says nothing about one reaching the other: an internal
 * hostname, a NetworkPolicy or a private CA are all invisible from here. Without this probe a
 * replication link is written ACTIVE and simply never moves an image, which is the single
 * most common way the mesh lies about itself. Returns the reason on failure, null on success.
 */
export async function pingHarborRegistryEndpoint(
  conn: RegistryConnection,
  id: number
): Promise<string | null> {
  const res = await registryFetch(conn, "/api/v2.0/registries/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })
  if (res.ok) return null

  // Harbor answers a plain text or {errors:[{message}]} body; either is more useful to an
  // operator than the status code alone.
  const detail = await res.text().catch(() => "")
  let message = detail.trim()
  try {
    const parsed = JSON.parse(detail) as { errors?: Array<{ message?: string }> }
    if (parsed.errors?.[0]?.message) message = parsed.errors[0].message
  } catch {
    // Not JSON — keep the raw body.
  }
  return message ? `${message} (${res.status})` : `Harbor could not reach this peer (${res.status})`
}

export async function deleteHarborRegistryEndpoint(conn: RegistryConnection, id: number): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/registries/${id}`, { method: "DELETE" })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Harbor registry endpoint deletion failed (${res.status})`)
  }
}

export type ReplicationTrigger =
  | { type: "event_based" }
  | { type: "scheduled"; cron: string }

function replicationPolicyBody(name: string, endpointId: number, trigger: ReplicationTrigger) {
  return {
    name,
    description: "Managed by Tessark Gateway — cluster replication.",
    // A null src_registry means "this Harbor is the source": policies always push outward.
    src_registry: null,
    dest_registry: { id: endpointId },
    // Empty namespace + -1 replace count keeps the project name identical on the peer, which
    // is what makes a pull work against any member with the same image reference.
    dest_namespace: "",
    dest_namespace_replace_count: -1,
    filters: [{ type: "name", value: "**" }],
    trigger:
      trigger.type === "scheduled"
        ? { type: "scheduled", trigger_settings: { cron: trigger.cron } }
        : { type: "event_based", trigger_settings: { cron: "" } },
    // Deletion propagation applies to event-based executions only; full/scheduled scans
    // cannot infer a deletion from absence.
    deletion: true,
    override: true,
    enabled: true,
  }
}

export async function createHarborReplicationPolicy(
  conn: RegistryConnection,
  name: string,
  endpointId: number,
  trigger: ReplicationTrigger
): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/replication/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(replicationPolicyBody(name, endpointId, trigger)),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`Harbor replication policy creation failed (${res.status})`)
  }

  const id = res.ok ? parseIdFromLocation(res) : null
  if (id) return id

  const existing = await findHarborReplicationPolicyIdByName(conn, name)
  if (!existing) throw new Error(`Could not resolve replication policy "${name}"`)
  if (!await updateHarborReplicationPolicy(conn, existing, name, endpointId, trigger)) throw new Error("Adopted Harbor policy disappeared during repair")
  return existing
}

export async function findHarborReplicationPolicyIdByName(
  conn: RegistryConnection,
  name: string
): Promise<number | null> {
  const res = await registryFetch(conn, `/api/v2.0/replication/policies?page_size=100&name=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const policies = (await res.json()) as Array<{ id: number; name: string }>
  return policies.find((p) => p.name === name)?.id ?? null
}

export async function updateHarborReplicationPolicy(
  conn: RegistryConnection,
  policyId: number,
  name: string,
  endpointId: number,
  trigger: ReplicationTrigger
): Promise<boolean> {
  if (!await harborObjectMatches(conn, `/api/v2.0/replication/policies/${policyId}`, name)) return false
  const res = await registryFetch(conn, `/api/v2.0/replication/policies/${policyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(replicationPolicyBody(name, endpointId, trigger)),
  })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Harbor replication policy update failed (${res.status})`)
  return true
}

/**
 * Switches a policy off without deleting it.
 *
 * Harbor refuses to delete a policy while any of its executions is not in a final state
 * ("PRECONDITION: contains executions that aren't in final status"), and event-based policies
 * start an execution on every push *and every deletion* — so a member removed just after any
 * activity is precisely when the delete fails. Disabling first means the object left behind in
 * that window is inert: an orphaned policy that still fires keeps moving images on a schedule
 * nothing in the Gateway can show or stop, which is the whole reason orphans matter.
 *
 * Read-modify-write rather than a partial PUT: Harbor replaces the policy with the body it is
 * given, so sending only `enabled` would clear the filters and the trigger.
 */
export async function disableHarborReplicationPolicy(
  conn: RegistryConnection,
  policyId: number
): Promise<void> {
  const current = await registryFetch(conn, `/api/v2.0/replication/policies/${policyId}`)
  if (current.status === 404) return
  if (!current.ok) throw new Error(`Harbor replication policy read failed (${current.status})`)

  const policy = (await current.json()) as Record<string, unknown>
  const res = await registryFetch(conn, `/api/v2.0/replication/policies/${policyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...policy, enabled: false }),
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Harbor replication policy disable failed (${res.status})`)
  }
}

export async function deleteHarborReplicationPolicy(conn: RegistryConnection, policyId: number): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/replication/policies/${policyId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Harbor replication policy deletion failed (${res.status})`)
  }
}

// Kicks a policy off immediately — used after a member rejoins, so it catches up on
// everything it missed instead of waiting for the next push event or cron tick.
export async function triggerHarborReplication(conn: RegistryConnection, policyId: number): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/replication/executions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy_id: policyId }),
  })
  if (!res.ok) throw new Error(`Harbor replication execution failed (${res.status})`)
  const id = parseIdFromLocation(res)
  if (!id) throw new Error("Harbor accepted replication without an execution ID; outcome is unknown")
  return id
}

export async function getHarborReplicationExecution(conn: RegistryConnection, id: number) {
  const res = await registryFetch(conn, `/api/v2.0/replication/executions/${id}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Harbor replication execution read failed (${res.status})`)
  return await res.json() as { id: number; status: string; failed?: number }
}

// One run of a replication policy, as Harbor reports it. This is the only place the mesh
// says anything about itself: the Gateway creates the policies but never sees the pushes, so
// "is replication actually working?" can only be answered by reading these back.
export interface HarborReplicationExecution {
  id: number
  policyId: number
  /** Harbor's vocabulary: Succeed | Failed | InProgress | Stopped. */
  status: string
  /** event_based | scheduled | manual */
  trigger: string
  startTime: string | null
  endTime: string | null
  total: number
  succeed: number
  failed: number
  inProgress: number
}

// Executions for every policy on this Harbor, newest first — one call covers all of a
// member's outgoing links, which is why this doesn't filter by policy: a mesh member has
// N-1 of them and N-1 round trips per page load would not be worth the precision.
export async function listHarborReplicationExecutions(
  conn: RegistryConnection,
  limit = 30,
  policyId?: number
): Promise<HarborReplicationExecution[]> {
  const res = await registryFetch(
    conn,
    `/api/v2.0/replication/executions?page_size=${limit}&sort=-start_time` +
      (policyId === undefined ? "" : `&policy_id=${policyId}`)
  )
  if (!res.ok) throw new Error(`Harbor replication executions request failed (${res.status})`)

  const body = (await res.json()) as Array<{
    id: number
    policy_id: number
    status?: string
    trigger?: string
    start_time?: string
    end_time?: string
    total?: number
    succeed?: number
    failed?: number
    in_progress?: number
  }>

  return body.map((execution) => ({
    id: execution.id,
    policyId: execution.policy_id,
    status: execution.status ?? "Unknown",
    trigger: execution.trigger ?? "unknown",
    startTime: execution.start_time ?? null,
    // Harbor sends the zero time ("0001-01-01T00:00:00Z") for a run still in flight rather
    // than omitting the field.
    endTime: execution.end_time && !execution.end_time.startsWith("0001-") ? execution.end_time : null,
    total: execution.total ?? 0,
    succeed: execution.succeed ?? 0,
    failed: execution.failed ?? 0,
    inProgress: execution.in_progress ?? 0,
  }))
}

// A scheduled *pull*: the far registry is the source and this Harbor is the destination,
// which is the mirror image of the mesh policies above (those always push outward, hence
// their hardcoded `src_registry: null`). Harbor holds the clock, the retries and the
// execution log; the Gateway only writes this object — see ScheduledMirror.
export interface HarborPullPolicyInput {
  name: string
  /** The registry endpoint describing where the image comes from. */
  srcEndpointId: number
  /** Repository path on the source, matched exactly — "library/nginx". */
  repo: string
  /** One tag, matched exactly — no glob. */
  tag: string
  /** The project on this Harbor the image lands in. */
  destProject: string
  /** 6-field cron, seconds first: Harbor's scheduler is robfig/cron, not crontab. */
  cron: string
  enabled: boolean
}

function pullPolicyBody(input: HarborPullPolicyInput) {
  return {
    name: input.name,
    description: "Managed by Tessark Gateway — scheduled mirror.",
    src_registry: { id: input.srcEndpointId },
    // Null destination means "this Harbor", the counterpart of a null source in a push policy.
    dest_registry: null,
    dest_namespace: input.destProject,
    // -1 flattens the source path to its last segment, so library/nginx lands as
    // <project>/nginx — the same name a skopeo transfer gives it (see shortRepoName).
    dest_namespace_replace_count: -1,
    filters: [
      { type: "name", value: input.repo },
      { type: "tag", value: input.tag },
    ],
    trigger: { type: "scheduled", trigger_settings: { cron: input.cron } },
    // No deletion mirroring, unlike the mesh: an upstream that drops a tag must not empty the
    // project that mirrored it. The whole point of a mirror is to stop depending on the
    // upstream still being there.
    deletion: false,
    // Re-pull a tag whose digest moved, which is exactly what "keep :latest fresh" means.
    override: true,
    enabled: input.enabled,
  }
}

export async function createHarborPullPolicy(
  conn: RegistryConnection,
  input: HarborPullPolicyInput
): Promise<number> {
  const res = await registryFetch(conn, "/api/v2.0/replication/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pullPolicyBody(input)),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`Harbor mirror policy creation failed (${res.status})`)
  }

  const id = res.ok ? parseIdFromLocation(res) : null
  if (id) return id

  const existing = await findHarborReplicationPolicyIdByName(conn, input.name)
  if (!existing) throw new Error(`Could not resolve mirror policy "${input.name}"`)
  return existing
}

export async function updateHarborPullPolicy(
  conn: RegistryConnection,
  policyId: number,
  input: HarborPullPolicyInput
): Promise<void> {
  const res = await registryFetch(conn, `/api/v2.0/replication/policies/${policyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pullPolicyBody(input)),
  })
  if (!res.ok) throw new Error(`Harbor mirror policy update failed (${res.status})`)
}
