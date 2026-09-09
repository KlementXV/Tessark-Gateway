// Per-rule adjustments on top of the instance-wide SKOPEO_* defaults.
//
// The defaults in src/lib/config.ts describe the installation; these describe one direction
// within it. A Harbor behind a self-signed certificate, a link that needs a longer deadline, a
// destination only reachable from certain nodes — none of that is a property of the Gateway,
// and putting it in the ConfigMap would force a redeploy to change something an operator
// edits in the UI.
//
// Stored as JSON text on TransferRule.skopeoOverrides. "{}" — the default — must produce a pod
// spec byte-for-byte identical to the one built without overrides at all.
import { z } from "zod"

// Kubernetes quantity, the form the config schema already accepts ("100m", "512Mi", "1").
const quantity = z.string().min(1).max(32)

// An allowlist, never a free-text string concatenated into the command. Every entry here is a
// flag skopeo takes with no argument, so nothing a caller writes can become a second word —
// which is what would turn this field into shell injection through the pod spec.
const SAFE_FLAGS = [
  "--src-tls-verify=false",
  "--dest-tls-verify=false",
  "--remove-signatures",
  "--preserve-digests",
  "--retry-times=3",
  "--retry-times=5",
] as const

export const skopeoOverridesSchema = z.object({
  image: z.string().min(1).max(300).optional(),
  cpuRequest: quantity.optional(),
  cpuLimit: quantity.optional(),
  memoryRequest: quantity.optional(),
  memoryLimit: quantity.optional(),
  activeDeadlineSeconds: z.number().int().min(1).max(86_400).optional(),
  nodeSelector: z.record(z.string(), z.string()).optional(),
  tolerations: z.array(z.record(z.string(), z.unknown())).optional(),
  extraArgs: z.array(z.enum(SAFE_FLAGS)).max(SAFE_FLAGS.length).optional(),
})

export type SkopeoOverrides = z.infer<typeof skopeoOverridesSchema>

/**
 * Reads the stored JSON, falling back to "no overrides" on anything unreadable.
 *
 * A row written by hand, or left over from an older shape, must not take transfers down: the
 * instance defaults are always a valid answer, and they are what this field is layered on.
 * Same reasoning as parseAllowedRepos.
 */
export function parseSkopeoOverrides(raw: string): SkopeoOverrides {
  try {
    const parsed = skopeoOverridesSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}
