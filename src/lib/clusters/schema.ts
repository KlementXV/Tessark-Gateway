import { z } from "zod"

import { normalizeClusterRegistryHost } from "@/lib/clusters/registry-url"

// A 6-field cron — Harbor's scheduler expects seconds first, unlike the 5-field crontab
// most people write from memory.
const cronSchema = z
  .string()
  .regex(/^\s*(\S+\s+){5}\S+\s*$/, "Expected a 6-field cron (seconds first), e.g. 0 0 * * * *")

export const clusterInputSchema = z
  .object({
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional().nullable(),
    // Accepts "registry.local" or "https://registry.local"; stored as the bare host either
    // way, since that is what an image reference carries.
    registryUrl: z
      .string()
      .trim()
      .max(253)
      .nullish()
      .superRefine((value, ctx) => {
        if (value && normalizeClusterRegistryHost(value) === null) {
          ctx.addIssue({
            code: "custom",
            message: "Use a hostname such as registry.local, optionally with a port",
          })
        }
      })
      .transform((value) => (value ? normalizeClusterRegistryHost(value) : null)),
    replicationMode: z.enum(["event_based", "scheduled", "none"]).default("event_based"),
    replicationCron: cronSchema.optional().nullable(),
    // Whose directory names this cluster's users — see ClusterIdentityMode in the Prisma
    // schema. Defaults to GATEWAY so an instance with a single directory behind everything
    // never has to think about it.
    identityMode: z.enum(["GATEWAY", "MAPPED"]).default("GATEWAY"),
  })
  .refine((v) => v.replicationMode !== "scheduled" || Boolean(v.replicationCron), {
    message: "A cron expression is required in scheduled mode",
    path: ["replicationCron"],
  })

export const clusterMemberInputSchema = z.object({
  registryId: z.string().min(1),
  // Set on the second call, once the operator has been shown which of this Harbor's projects
  // the mesh would adopt and spread. See addClusterMember / inspectJoinCandidate.
  acceptExisting: z.boolean().optional(),
})

// A Harbor account name, as the cluster's directory spells it. Harbor allows a fairly loose
// character set (LDAP DNs get mapped onto it), so this only rejects what could not be a
// username at all rather than trying to mirror Harbor's own rules.
export const clusterIdentityInputSchema = z.object({
  userId: z.string().min(1),
  harborUsername: z.string().trim().min(1).max(255),
})

export type ClusterIdentityInput = z.infer<typeof clusterIdentityInputSchema>

export type ClusterInput = z.infer<typeof clusterInputSchema>
