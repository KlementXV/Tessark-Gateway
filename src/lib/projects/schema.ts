import { z } from "zod"

import { ProjectMemberRole } from "@/generated/prisma/client"
import { ROBOT_SECRET_MAX_LENGTH, robotSecretPolicyError } from "@/lib/clusters/robot-secret"

export const projectCreateInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . only"),
  description: z.string().max(500).optional().nullable(),
  clusterId: z.string().min(1),
  isPublic: z.boolean().default(false),
})

export const projectRejectInputSchema = z.object({
  reason: z.string().min(1).max(500),
})

// Asking for a project to be deleted. The reason is required, unlike the one on a quota
// request: a reviewer is being asked to destroy something, and "why" is the whole of what they
// have to go on — the project itself says nothing about whether it is still needed.
export const projectDeleteRequestInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

export const memberAddInputSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ProjectMemberRole).default(ProjectMemberRole.DEVELOPER),
  // The account this person holds in the cluster's own directory, when the cluster keeps one
  // (ClusterIdentityMode.MAPPED). Supplied by the picker from Harbor's user search, it is
  // recorded as the user's mapping for that cluster before the grant is fanned out. Omitted
  // when a mapping already exists, and ignored by a GATEWAY-mode cluster.
  harborUsername: z.string().trim().min(1).max(255).optional(),
})

// A directory group, named as the cluster's Harbor knows it. Picked from that Harbor's own
// list (see listHarborUserGroups) rather than typed, for the same reason a user account is.
export const groupAddInputSchema = z.object({
  groupName: z.string().trim().min(1).max(255),
  role: z.enum(ProjectMemberRole).default(ProjectMemberRole.DEVELOPER),
})

// Optional everywhere it appears: omit it and the Gateway generates one. A supplied secret is
// validated against Harbor's own policy here, so a rejection surfaces in the form instead of
// partway through a fan-out that has already touched some members.
const robotSecretSchema = z
  .string()
  .max(ROBOT_SECRET_MAX_LENGTH)
  .optional()
  .nullable()
  .transform((value) => value || null)
  .superRefine((value, ctx) => {
    const error = value === null ? null : robotSecretPolicyError(value)
    if (error) ctx.addIssue({ code: "custom", message: error })
  })

export const robotCreateInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . only"),
  description: z.string().max(200).optional().nullable(),
  expiresInDays: z.number().int().positive().max(3650).optional().nullable(),
  secret: robotSecretSchema,
})

export const robotSecretRotateInputSchema = z.object({
  secret: robotSecretSchema,
})

// Null lifts the limit. The ceiling is 1 PiB expressed in MiB — past anything a registry
// will hold, while still fitting the 32-bit column Prisma's Int maps to.
export const QUOTA_MAX_MIB = 1024 * 1024 * 1024

export const quotaUpdateInputSchema = z.object({
  storageQuotaMib: z.number().int().min(1).max(QUOTA_MAX_MIB).nullable(),
})

// What a project manager asks an admin for. `storageQuotaMib` carries the same meaning as in
// quotaUpdateInputSchema — null is a real request ("lift the limit"), not an omitted field —
// and the reason is the free text the reviewer reads in the queue.
export const quotaRequestInputSchema = z.object({
  storageQuotaMib: z.number().int().min(1).max(QUOTA_MAX_MIB).nullable(),
  reason: z.string().max(500).optional().nullable().transform((value) => value?.trim() || null),
})

export const retentionUpdateInputSchema = z.object({
  keepLastN: z.number().int().min(1).max(1000),
  tagPattern: z.string().min(1).max(200).default("**"),
})
