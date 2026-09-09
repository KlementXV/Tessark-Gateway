import { z } from "zod"

import { RegistryRole } from "@/generated/prisma/client"

const registryFields = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  // What the Gateway may do with this Harbor — see the RegistryRole comments in
  // prisma/schema.prisma. MANAGED by default: adding a registry has always meant "this one is
  // mine to drive", and a default that silently narrowed that would be a surprising change.
  role: z.enum(RegistryRole).default(RegistryRole.MANAGED),
  authType: z.enum(["none", "basic", "token"]).default("none"),
  username: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  insecureTLS: z.boolean().default(false),
  description: z.string().optional().nullable(),
})

export const registryInputSchema = registryFields

// Edits are partial — the form sends only what changed.
export const registryUpdateInputSchema = registryFields.partial()

export type RegistryInput = z.infer<typeof registryInputSchema>
