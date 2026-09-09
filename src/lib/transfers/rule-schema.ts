import { z } from "zod"

import { skopeoOverridesSchema } from "./skopeo-overrides"

// A glob over one path-like value — a repository path on the source, or a project name on the
// destination. Same grammar and same matcher as UpstreamSource.allowedRepos, deliberately:
// two glob dialects in one product would be a trap.
const globSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9*]+(?:[-_./][a-z0-9*]+)*\/?\**$/, "Lowercase letters, numbers, - _ . / and * only")

// The bare object. The "at most one source" check lives in `atMostOneSource` below rather
// than here, because zod refuses `.partial()` on a schema that already carries refinements —
// and the update form needs the partial.
const transferRuleObject = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  // Null on a side means "any". Both source fields null opens every source; a null
  // destination opens every destination, managed or delivery.
  sourceUpstreamId: z.string().min(1).optional().nullable(),
  sourceRegistryId: z.string().min(1).optional().nullable(),
  destRegistryId: z.string().min(1).optional().nullable(),
  // Empty is a legitimate value and means "nothing matches" — the same reading as an empty
  // allowedRepos on a source. An operator who wants everything writes ["**"] explicitly.
  projectFilter: z.array(globSchema).max(50),
  repoFilter: z.array(globSchema).max(50),
  requiresApproval: z.boolean().default(true),
  enabled: z.boolean().default(true),
  // Empty means "the instance defaults, unchanged" — see skopeo-overrides.ts.
  skopeoOverrides: skopeoOverridesSchema.default({}),
})

// A rule names at most one source: a transfer has one, so pinning two would describe nothing.
const atMostOneSource = (input: { sourceUpstreamId?: string | null; sourceRegistryId?: string | null }) =>
  !(input.sourceUpstreamId && input.sourceRegistryId)

const ONE_SOURCE = {
  message: "A rule names at most one source: an upstream source, or a registry.",
  path: ["sourceRegistryId"],
}

export const transferRuleInputSchema = transferRuleObject.refine(atMostOneSource, ONE_SOURCE)

// Edits are partial — the form sends only what changed, same convention as sourceUpdateInputSchema.
export const transferRuleUpdateInputSchema = transferRuleObject.partial().refine(atMostOneSource, ONE_SOURCE)

export type TransferRuleInput = z.infer<typeof transferRuleInputSchema>
