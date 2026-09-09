/**
 * Filename for a downloaded SBOM.
 *
 * The name is what the reader is left with once the file leaves the browser, so it carries
 * both coordinates — which repository, which tag or digest — rather than a bare "sbom.json"
 * that becomes "sbom (3).json" by the fourth download. The extension states the format the
 * document actually announced: Harbor 2.15 with Trivy emits SPDX, so naming everything
 * `.cdx.json` would mislabel the file for whoever opens it next.
 *
 * Every character outside a conservative set is folded to `-` because this string ends up
 * inside a `Content-Disposition` header, where a stray quote or newline would be a
 * header-injection bug rather than a cosmetic one.
 */
export function sbomFilename(
  repo: string,
  reference: string,
  format: "spdx" | "cyclonedx" | "json"
): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  const extension = format === "spdx" ? "spdx.json" : format === "cyclonedx" ? "cdx.json" : "json"
  return `sbom-${safe(repo)}-${safe(reference)}.${extension}`.slice(0, 200)
}
