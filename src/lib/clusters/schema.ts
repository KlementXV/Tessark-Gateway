import { z } from "zod"

import { normalizeClusterRegistryHost } from "@/lib/clusters/registry-url"

// A 6-field cron — Harbor's scheduler expects seconds first, unlike the 5-field crontab
// most people write from memory.
const cronSchema = z
  .string()
  .regex(/^\s*(\S+\s+){5}\S+\s*$/, "Expected a 6-field cron (seconds first), e.g. 0 0 * * * *")

// The LDAP settings the Gateway may write onto a cluster's Harbors (clusters/directory-config.ts).
// Harbor's scope encoding: 0 = base, 1 = one level, 2 = subtree.
const ldapScopeSchema = z.coerce.number().int().min(0).max(2)

export const clusterDirectoryConfigInputSchema = z.object({
  enabled: z.boolean().default(false),
  url: z
    .string()
    .trim()
    .max(512)
    .regex(/^ldaps?:\/\/[^\s/]+\/?$/i, "Expected ldap://host[:port] or ldaps://host[:port]"),
  searchDn: z.string().trim().max(1024).default(""),
  // Omitted keeps the stored password; an empty string clears it.
  searchPassword: z.string().max(1024).optional(),
  baseDn: z.string().trim().min(1).max(1024),
  filter: z.string().trim().max(1024).default(""),
  uid: z.string().trim().min(1).max(128).default("uid"),
  scope: ldapScopeSchema.default(2),
  verifyCert: z.boolean().default(true),
  groupBaseDn: z.string().trim().max(1024).default(""),
  groupSearchFilter: z.string().trim().max(1024).default(""),
  groupAttributeName: z.string().trim().max(128).default("cn"),
  groupMembershipAttribute: z.string().trim().max(128).default("memberof"),
  groupSearchScope: ldapScopeSchema.default(2),
})

export const clusterDirectoryApplyInputSchema = z.object({
  force: z.boolean().default(false),
  setAuthMode: z.boolean().default(false),
  // The dialog names the blast radius before sending this; an API caller has to say it too.
  confirm: z.literal(true),
})

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
