import { z } from "zod"

import { enterpriseCaPemField } from "@/lib/ca"

import { MAX_RETENTION_DAYS } from "@/lib/history/window"
import { isSafeLogoUrl, normalizeHexColor } from "@/lib/settings/branding"
import {
  LOGIN_FEATURE_DESCRIPTION_MAX,
  LOGIN_FEATURE_TITLE_MAX,
  LOGIN_TEXT_MAX,
  MAX_LOGIN_FEATURES,
} from "@/lib/settings/login-content"

// Inputs arrive from a form where cleared fields are "" — normalize here so the
// route handler and the database only ever see trimmed values or null.
export const instanceSettingsInputSchema = z.object({
  brandName: z.string().trim().min(1, "Brand name is required").max(60),
  brandTagline: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((value) => value ?? ""),
  logoUrl: z
    .string()
    .trim()
    .max(2048)
    .nullish()
    .transform((value) => value || null)
    .refine((value) => value === null || isSafeLogoUrl(value), {
      message: "Use an https:// URL or a path like /logo.svg",
    }),
  primaryColor: z
    .string()
    .trim()
    .nullish()
    .refine((value) => !value || normalizeHexColor(value) !== null, {
      message: "Use a hex color, e.g. #3b82f6",
    })
    .transform((value) => (value ? normalizeHexColor(value) : null)),
})

export type InstanceSettingsInput = z.infer<typeof instanceSettingsInputSchema>

// Login page copy. Every field is optional and an empty string clears the override
// back to the built-in, translated text — the form always submits every field, so
// "" is how the admin says "use the default" rather than a missing key.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null)

export const loginContentInputSchema = z.object({
  description: optionalText(LOGIN_TEXT_MAX),
  heroTitle: optionalText(LOGIN_TEXT_MAX),
  heroSubtitle: optionalText(LOGIN_TEXT_MAX),
  footnote: optionalText(LOGIN_TEXT_MAX),
  // null (or absent) keeps the built-in bullets; [] is a deliberate "show none".
  features: z
    .array(
      z.object({
        title: z.string().trim().min(1, "Feature title is required").max(LOGIN_FEATURE_TITLE_MAX),
        description: z.string().trim().max(LOGIN_FEATURE_DESCRIPTION_MAX),
      }),
    )
    .max(MAX_LOGIN_FEATURES)
    .nullish()
    .transform((value) => value ?? null),
})

export type LoginContentInput = z.infer<typeof loginContentInputSchema>

// How long settled requests are kept. Zero is a deliberate value, not an empty field: it turns
// the purge off and keeps everything, which is what an instance under an audit obligation
// wants. Coerced because the form submits a string, and integer-only because "keep 2.5 days"
// is a typo rather than a policy.
export const historySettingsInputSchema = z.object({
  historyRetentionDays: z.coerce
    .number()
    .int("Use a whole number of days")
    .min(0, "Use 0 to keep everything, or a number of days")
    .max(MAX_RETENTION_DAYS, `At most ${MAX_RETENTION_DAYS} days`),
})

export type HistorySettingsInput = z.infer<typeof historySettingsInputSchema>

// The instance-wide private authority. `null` removes it; an omitted field is refused by the
// route rather than read as "keep", because this endpoint has exactly one field — a PUT with
// nothing in it can only be a client bug.
export const enterpriseCaInputSchema = z.object({
  enterpriseCaPem: enterpriseCaPemField(),
  // Whether the skopeo copy Jobs get the bundle by default. Independent of the bundle itself:
  // an operator may flip it without re-pasting the certificate, and the route refuses a body
  // that names neither.
  enterpriseCaJobDefault: z.boolean().optional(),
})
