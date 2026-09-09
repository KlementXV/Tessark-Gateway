// The bounds of the retention window, kept apart from retention.ts because the settings form is
// a client component: importing them from the module that also imports Prisma would drag the
// database client into the browser bundle.

export const DEFAULT_RETENTION_DAYS = 30
/** Ten years. Not a limit anyone will reach — a guard against a typo becoming a 0-day purge. */
export const MAX_RETENTION_DAYS = 3650

/** Whether a value is a usable window: a whole number of days, 0 meaning "keep everything". */
export function isValidRetentionDays(days: number): boolean {
  return Number.isInteger(days) && days >= 0 && days <= MAX_RETENTION_DAYS
}
