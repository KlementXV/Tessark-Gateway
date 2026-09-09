// Validation and shaping of the per-connection private CA bundles (docs/plan-custom-ca-beta.md).
//
// A CA is a *public* certificate, so it is stored in clear in the database — unlike a registry
// password, there is nothing here to encrypt. What matters instead is that what gets stored is
// certificates and nothing else: the bundle is projected into a Job's filesystem, so a stray
// private key pasted in by mistake would end up mounted in a pod.
import { createHash } from "node:crypto"
import { z } from "zod"

import { getConfig } from "@/lib/config"

const CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

export const CUSTOM_CA_DISABLED_REASON =
  "The custom CA beta is disabled on this instance (CUSTOM_CA_BETA_ENABLED=false)."

export const MAX_CA_BUNDLE_BYTES = 64 * 1024

/**
 * Parses a PEM bundle down to its certificate blocks, or throws with a message an admin can act
 * on. Syntactic validity proves nothing about trust — only the TLS probe does — so this stops at
 * "these are certificate blocks and nothing else": anything the regex does not claim (a private
 * key, a stray header, prose pasted along with the certificate) is left over and refused.
 */
export function normalizeCaPem(value: string): string {
  if (typeof value !== "string" || value.length > MAX_CA_BUNDLE_BYTES) {
    throw new Error("CA bundle must be at most 64 KiB")
  }
  const certs = value.match(CERT_RE) ?? []
  if (certs.length === 0 || certs.length > 10) {
    throw new Error("CA bundle must contain between 1 and 10 PEM certificates")
  }
  const rest = value.replace(CERT_RE, "").replace(/[\s\r\n]/g, "")
  if (rest) throw new Error("CA bundle contains unsupported content")
  // Deduplicated after normalising line endings: pasting the same root twice is a common
  // copy/paste accident, and two identical blocks would otherwise change the fingerprint and
  // make a no-op edit look like a rotation.
  const seen = new Set<string>()
  const blocks: string[] = []
  for (const cert of certs) {
    const normalized = cert.replace(/\r\n/g, "\n").trim()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    blocks.push(normalized)
  }
  return blocks.join("\n") + "\n"
}

/** Identifies a bundle in logs and in the UI without ever printing the PEM itself. */
export function caFingerprint(pem: string): string {
  return createHash("sha256").update(pem).digest("hex")
}

/**
 * The PEM field of the enterprise-CA settings route.
 *
 * Omitted keeps what is stored, `null` removes it, an empty string is refused rather than read
 * as a removal: "the admin cleared the textarea" and "the admin did not touch it" must not be
 * the same request. The beta gate lives here rather than in the UI alone so that a token-driven
 * API call is refused too (docs/plan-custom-ca-beta.md, decision 1).
 */
export function enterpriseCaPemField() {
  return z
    .string()
    .max(MAX_CA_BUNDLE_BYTES)
    .nullable()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === null) return value
      if (!getConfig().customCaBetaEnabled) {
        ctx.addIssue({ code: "custom", message: CUSTOM_CA_DISABLED_REASON })
        return z.NEVER
      }
      try {
        return normalizeCaPem(value)
      } catch (err) {
        ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : "Invalid CA bundle" })
        return z.NEVER
      }
    })
}
