import { z } from "zod"

export const apiTokenCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // The TTL cap itself (API_TOKEN_MAX_TTL_DAYS) is enforced in service.ts, not here — it's
  // runtime config, not a structural property of the input.
  expiresAt: z.iso.datetime().optional().nullable(),
})

export type ApiTokenCreateInput = z.infer<typeof apiTokenCreateInputSchema>
