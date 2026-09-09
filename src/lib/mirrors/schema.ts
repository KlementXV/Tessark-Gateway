import { z } from "zod"

import { isValidSchedule } from "./cron"

// Same shape as the transfer form, and for the same reason: the host always comes from a row
// the Gateway holds, so there is no field in which to name an unapproved registry. What a
// mirror adds is the schedule and the transport — see ScheduledMirror in prisma/schema.prisma.

const harborProjectName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . only")

const repoPath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9]+(?:[-_./][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . / only")

export const mirrorTransports = ["harbor", "skopeo"] as const
export type MirrorTransport = (typeof mirrorTransports)[number]

export const mirrorCreateObject = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . only"),
  description: z.string().max(500).optional().nullable(),
  // Source: exactly one of the two forms (refined below).
  sourceId: z.string().min(1).optional(),
  sourceRegistryId: z.string().min(1).optional(),
  sourceProjectName: harborProjectName.optional(),
  repo: repoPath,
  tag: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\w[\w.-]*$/, "Letters, numbers, and _ . - only")
    .default("latest"),
  // Destination: exactly one of the two coordinate forms (refined below).
  projectId: z.string().min(1).optional(),
  destRegistryId: z.string().min(1).optional(),
  destProjectName: harborProjectName.optional(),
  targetRepo: repoPath.optional().nullable(),
  schedule: z
    .string()
    .min(1)
    .refine(isValidSchedule, "Expected a 5-field crontab in UTC, e.g. 0 3 * * *"),
  transport: z.enum(mirrorTransports).default("harbor"),
  enabled: z.boolean().default(true),
})

function hasExactlyOneSource(input: { sourceId?: string; sourceRegistryId?: string; sourceProjectName?: string }) {
  return Boolean(input.sourceId) !== Boolean(input.sourceRegistryId && input.sourceProjectName)
}

function hasExactlyOneDestination(input: { projectId?: string; destRegistryId?: string; destProjectName?: string }) {
  return Boolean(input.projectId) !== Boolean(input.destRegistryId && input.destProjectName)
}

export const mirrorCreateInputSchema = mirrorCreateObject
  .refine(hasExactlyOneSource, {
    message: "Name exactly one source: an upstream source, or a project on a registry.",
  })
  .refine(hasExactlyOneDestination, {
    message: "Name exactly one destination: a Gateway project, or a project on a delivery registry.",
  })

export type MirrorCreateInput = z.infer<typeof mirrorCreateInputSchema>

// What a mirror can be changed to without being recreated. The source and the destination are
// deliberately not in here: changing either makes it a different mirror, and reusing the row
// would leave the old transport object installed under a name that now means something else.
export const mirrorUpdateInputSchema = z.object({
  description: z.string().max(500).optional().nullable(),
  schedule: z
    .string()
    .min(1)
    .refine(isValidSchedule, "Expected a 5-field crontab in UTC, e.g. 0 3 * * *")
    .optional(),
  tag: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\w[\w.-]*$/, "Letters, numbers, and _ . - only")
    .optional(),
  enabled: z.boolean().optional(),
})

export type MirrorUpdateInput = z.infer<typeof mirrorUpdateInputSchema>
