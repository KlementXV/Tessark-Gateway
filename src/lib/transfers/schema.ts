import { z } from "zod"

// The transfer form takes no free-text image reference: the host always comes from a row the
// Gateway holds — an UpstreamSource an admin approved, or a Registry it already knows — so
// only the path within it and the tag are user input. That is what makes "limit where images
// come from" enforceable: there is no field in which to name an unapproved registry.
const targetRepoField = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]+(?:[-_./][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . / only")
  .optional()
  .nullable()

const repoField = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9]+(?:[-_./][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . / only")

// Docker's own tag grammar: alphanumeric or underscore first, then word characters, dots and
// dashes.
const tagField = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\w[\w.-]*$/, "Letters, numbers, and _ . - only")
  .default("latest")

// Harbor's project-name grammar: lowercase, one namespace segment, never a path.
const harborProjectName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "Lowercase letters, numbers, and - _ . only")

// The bare object, exported because the MCP tool builds its input schema from `.shape`,
// which the refined version below no longer exposes.
export const transferRequestCreateObject = z.object({
  // The source, in one of the two forms of TransferRequest — an allowed upstream host, or a
  // project on a Harbor the Gateway knows. Discriminated on the field present rather than on
  // a `kind` tag, matching how the destinations below are posted.
  sourceId: z.string().min(1).optional(),
  sourceRegistryId: z.string().min(1).optional(),
  sourceProjectName: harborProjectName.optional(),
  repo: repoField,
  tag: tagField,
  // Whether the enterprise CA travels with this transfer (see TransferRequest.useCustomCa).
  // Deliberately without a zod default: omitted means "whatever the instance says" — resolved
  // against InstanceSettings.enterpriseCaJobDefault — which is not the same statement as an
  // explicit `true` from a client that has an opinion.
  useCustomCa: z.boolean().optional(),
  // One entry per destination. Capped because each becomes its own Kubernetes Job, and a
  // request fanning out to dozens of destinations is a mirror rule, not a transfer.
  //
  // Each entry is a coordinate in one of the two forms of TransferTarget: a Gateway-managed
  // project, or a project on a delivery registry. The union is discriminated on the fields
  // present rather than on a `kind` tag, because that is what a form naturally posts.
  targets: z
    .array(
      z.union([
        z.object({
          projectId: z.string().min(1),
          targetRepo: targetRepoField,
        }),
        z.object({
          destRegistryId: z.string().min(1),
          destProjectName: harborProjectName,
          targetRepo: targetRepoField,
        }),
      ]),
    )
    .min(1, "Pick at least one destination")
    .max(10),
})

export const transferRequestCreateInputSchema = transferRequestCreateObject.refine(
  (input) => Boolean(input.sourceId) !== Boolean(input.sourceRegistryId && input.sourceProjectName),
  { message: "Name exactly one source: an upstream source, or a project on a registry." },
)

export type TransferRequestCreateInput = z.infer<typeof transferRequestCreateInputSchema>

// Where one image comes from, in the two forms TransferRequest holds. Optional on every field
// because a batch entry may say nothing and inherit the batch's own source.
const imageSourceObject = z.object({
  sourceId: z.string().min(1).optional(),
  sourceRegistryId: z.string().min(1).optional(),
  sourceProjectName: harborProjectName.optional(),
})

/**
 * The same request, for several images at once — what the dialog posts when an operator pastes
 * a list rather than naming one image.
 *
 * The destinations and the CA answer are shared; the source is not. A line may carry its own
 * host — "quay.io/prometheus/node-exporter" — and then names its own source, while a line
 * without one inherits the source named at the top. That is what lets one paste mix Docker Hub
 * and a DMZ Harbor, which is how an operator's list actually looks.
 *
 * Each entry still becomes its own TransferRequest, because that is what a transfer *is* here —
 * one image, its own approval, its own status, its own retry. A batch is a way of filling the
 * form N times, not a new kind of row.
 */
export const transferRequestBatchInputSchema = transferRequestCreateObject
  .omit({ repo: true, tag: true })
  .extend({
    // Capped well below what the targets cap allows per request: a hundred images across ten
    // destinations is a thousand Jobs, which is a mirror rule, not a paste.
    images: z
      .array(imageSourceObject.extend({ repo: repoField, tag: tagField }))
      .min(1)
      .max(50),
  })
  .superRefine((input, ctx) => {
    // The top-level source is now a default rather than the source: a batch whose every line
    // names its own host needs none. It still has to be a complete form when it is given.
    if (input.sourceId && input.sourceRegistryId) {
      ctx.addIssue({
        code: "custom",
        message: "Name exactly one source: an upstream source, or a project on a registry.",
      })
    }
    // The same image twice would raise two requests for one intention: two rows to review, two
    // Jobs racing for the same destination tag. Refused rather than deduplicated, because a
    // duplicate in a pasted list is usually a mistake in the list and worth seeing.
    //
    // Keyed on the source too: the same repository taken from two registries is two different
    // images that happen to share a name, and refusing the second would be wrong.
    const seen = new Map<string, number>()
    input.images.forEach((image, index) => {
      const source = resolveImageSource(input, image)
      if (!source) {
        ctx.addIssue({
          code: "custom",
          path: ["images", index],
          message: `${image.repo}:${image.tag} names no source: give one on the line, or pick a default.`,
        })
        return
      }
      const key = `${source.sourceId ?? `${source.sourceRegistryId}/${source.sourceProjectName}`}|${image.repo}:${image.tag}`
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, index)
        return
      }
      ctx.addIssue({
        code: "custom",
        path: ["images", index],
        message: `${image.repo}:${image.tag} is already on line ${first + 1}`,
      })
    })
  })

export type TransferRequestBatchInput = z.infer<typeof transferRequestBatchInputSchema>

/** One resolved source, in the exact shape validateTransferRequest() takes it. */
export interface ResolvedImageSource {
  sourceId?: string
  sourceRegistryId?: string
  sourceProjectName?: string
}

/**
 * Which source one entry of a batch comes from: its own, or the batch's.
 *
 * Inheritance is all-or-nothing — an entry naming a registry brings its project with it rather
 * than borrowing the batch's, since a project name means nothing on another Harbor. Returns
 * null when neither side names a complete source, which the caller reports against that line.
 */
export function resolveImageSource(
  input: Pick<TransferRequestBatchInput, "sourceId" | "sourceRegistryId" | "sourceProjectName">,
  image: z.infer<typeof imageSourceObject>,
): ResolvedImageSource | null {
  if (image.sourceId) return { sourceId: image.sourceId }
  if (image.sourceRegistryId && image.sourceProjectName) {
    return {
      sourceRegistryId: image.sourceRegistryId,
      sourceProjectName: image.sourceProjectName,
    }
  }
  // A half-named source on the line is not a reason to fall back on the default: it is a line
  // the caller got wrong, and inheriting would silently pull from somewhere else.
  if (image.sourceRegistryId || image.sourceProjectName) return null
  if (input.sourceId) return { sourceId: input.sourceId }
  if (input.sourceRegistryId && input.sourceProjectName) {
    return {
      sourceRegistryId: input.sourceRegistryId,
      sourceProjectName: input.sourceProjectName,
    }
  }
  return null
}
