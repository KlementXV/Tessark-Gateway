// API routes return either a plain string error, or a zod `.flatten()` object
// ({ formErrors, fieldErrors }) on 400s. Never render the latter directly — pick the first
// available message out of it, since React throws if handed an object as a child (this is
// what was happening: falling back straight to `body?.error` handed the raw flatten() object
// to toast.error() whenever fieldErrors had entries but formErrors didn't).
interface FlattenedError {
  formErrors?: string[]
  fieldErrors?: Record<string, string[] | undefined>
}

export function extractErrorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: string | FlattenedError } | null)?.error
  if (!error) return fallback
  if (typeof error === "string") return error

  if (error.formErrors?.[0]) return error.formErrors[0]

  const fieldMessage = error.fieldErrors && Object.values(error.fieldErrors).find((v) => v?.[0])?.[0]
  return fieldMessage ?? fallback
}
