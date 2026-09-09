import { z } from "zod"

// Bare host, the form an image reference takes: no scheme, no path, optional port. Rejecting
// "https://docker.io" here rather than stripping it keeps one canonical spelling in the
// column, which `host` being @unique depends on.
const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/,
    "Bare registry host, no scheme or path — e.g. docker.io or registry.example.com:5000",
  )

// A glob over repository paths. `/` is allowed (paths are nested), `*` and `**` are the two
// wildcards — see src/lib/sources/repo.ts.
const repoGlobSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9*]+(?:[-_./][a-z0-9*]+)*\/?\**$/, "Lowercase letters, numbers, - _ . / and * only")

export const sourceInputSchema = z.object({
  name: z.string().min(1).max(100),
  host: hostSchema,
  authType: z.enum(["none", "basic", "token"]).default("none"),
  username: z.string().max(200).optional().nullable(),
  secret: z.string().max(2000).optional().nullable(),
  // Never defaulted to ["**"] on the way in: an admin who leaves the field empty means "I
  // haven't decided", and the safe reading of that is an empty allowlist, not the whole host.
  // The default lives on the column for rows created some other way.
  allowedRepos: z.array(repoGlobSchema).max(50),
  enabled: z.boolean().default(true),
  description: z.string().max(500).optional().nullable(),
})

// Edits are partial — the form sends only what changed, and an omitted `secret` means "keep
// the stored one" rather than "clear it".
export const sourceUpdateInputSchema = sourceInputSchema.partial()

export type SourceInput = z.infer<typeof sourceInputSchema>
