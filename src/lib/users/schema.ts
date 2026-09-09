import { z } from "zod"

import { Role } from "@/generated/prisma/client"

// Zod's `.email()` insists on a dotted public domain, which rejects the intranet addresses
// this on-prem tool actually runs on — the bootstrapped SUPERADMIN itself is `admin@local`
// (prisma/seed.ts), so the strict rule locked that account out of its own settings page.
// Require the shape that matters instead: one @, a non-empty local part, and a host with no
// whitespace.
const emailSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[^\s@]+@[^\s@]+$/, "Enter a valid email address")

export const userCreateInputSchema = z.object({
  username: z.string().min(3).max(40),
  email: emailSchema,
  name: z.string().max(100).optional().nullable(),
  password: z.string().min(8).max(200),
  role: z.enum(Role),
})

export const userUpdateInputSchema = z.object({
  name: z.string().max(100).optional().nullable(),
  role: z.enum(Role).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
})

// Self-service edits, for the signed-in user's own account. Unlike the admin schemas
// above there is no `role` or `disabled` here — nobody promotes or re-enables themselves —
// and the password change carries the current password so it can be re-verified.
export const profileUpdateInputSchema = z.object({
  name: z
    .string()
    .trim()
    .max(100)
    .nullish()
    // A cleared field arrives as "", which is not a name — store null so the UI keeps
    // falling back to the username.
    .transform((value) => value || null),
  email: emailSchema,
  username: z.string().trim().min(3).max(40),
})

export const passwordChangeInputSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(8, "Use at least 8 characters").max(200),
})

export type UserCreateInput = z.infer<typeof userCreateInputSchema>
export type UserUpdateInput = z.infer<typeof userUpdateInputSchema>
export type ProfileUpdateInput = z.infer<typeof profileUpdateInputSchema>
export type PasswordChangeInput = z.infer<typeof passwordChangeInputSchema>
