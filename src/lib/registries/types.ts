export type RegistryAuthType = "none" | "basic" | "token"

// Fully-resolved connection (secret decrypted) — never send this over the wire to the client.
// `id` is empty for an unsaved connection being probed by POST /api/registries/check.
export interface RegistryConnection {
  id: string
  name: string
  baseUrl: string
  authType: RegistryAuthType
  username: string | null
  secret: string | null
  insecureTLS: boolean
}

export interface RepositorySummary {
  name: string
}

export interface TagSummary {
  name: string
}

export interface ManifestLayer {
  digest: string
  size: number
  mediaType: string
}

export interface ManifestInfo {
  digest: string
  mediaType: string
  totalSize: number
  layers: ManifestLayer[]
  createdAt?: string
}

export interface HarborVulnerabilitySummary {
  critical: number
  high: number
  medium: number
  low: number
  /**
   * Trivy's fifth bucket, for findings it cannot grade. Real and not small — a Debian-based
   * nginx reports ~48 of them out of 318 — so leaving it out of the model does not merely
   * undercount: an artifact whose findings are *all* ungraded would come out summing to zero
   * and be presented as clean.
   */
  unknown: number
  /**
   * Harbor's own total, which is the authority on whether anything was found at all. Summing
   * the buckets instead would silently absolve any severity label this code does not know.
   */
  total: number
  /** Findings that have a fixed version available, when Harbor's report carries the count. */
  fixable?: number
  /** Scanner name and version as one string, e.g. "Trivy 0.50.1" — what produced the report. */
  scanner?: string
  /** Harbor's scan job state for this artifact: "Success", "Running", "Error", "Not Scanned"… */
  scanStatus?: string
  scanCompletedAt?: string
}

/**
 * What Harbor reports about an artifact's software supply chain: whether it carries a Cosign
 * signature, an SBOM, and any attestations.
 *
 * Presence only. The Gateway does not verify the signature cryptographically — it trusts what
 * Harbor says here. Real verification (trusted keys, keyless identities, Rekor) is deferred,
 * see docs/plan-supply-chain.md lot 7. Null means Harbor answered nothing at all — a registry
 * that is not a Harbor, or one too old to report accessories — as opposed to `signed: false`,
 * which is Harbor saying it looked and found none.
 */
export interface HarborSupplyChainSummary {
  signed: boolean
  sbom: boolean
  signatureCount: number
  attestationCount: number
}
