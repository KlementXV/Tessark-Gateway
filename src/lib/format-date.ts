// Dates rendered inside client components have to format identically on the server and in the
// browser, or React tears the tree down and re-renders it (a hydration mismatch). Bare
// `toLocaleDateString()` does not: the server formats with the Node process locale and time
// zone, the browser with the visitor's, so the same timestamp comes out "02/08/2026" on one
// side and "8/2/2026" on the other.
//
// Both are pinned here: the time zone to UTC, the locale to the one next-intl resolved for the
// request (identical on both sides, since the client provider receives it from the server).
// The month is spelled out rather than numeric because a fleet console is read by people in
// several countries, and "02/08" is a different day depending on who is looking — an
// ambiguity worth spending three characters to remove.
import type { Locale } from "@/i18n/locale"

const BCP47: Record<Locale, string> = { en: "en-GB", fr: "fr-FR" }

const dateFormatters = new Map<Locale, Intl.DateTimeFormat>()
const dateTimeFormatters = new Map<Locale, Intl.DateTimeFormat>()

function dateFormatter(locale: Locale) {
  let formatter = dateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(BCP47[locale], {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    })
    dateFormatters.set(locale, formatter)
  }
  return formatter
}

function dateTimeFormatter(locale: Locale) {
  let formatter = dateTimeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(BCP47[locale], {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    })
    dateTimeFormatters.set(locale, formatter)
  }
  return formatter
}

/** "2 Aug 2026" / "2 août 2026" */
export function formatDate(value: string | Date, locale: Locale): string {
  return dateFormatter(locale).format(new Date(value))
}

/** "2 Aug 2026, 20:49 UTC" — the zone is named because it is not the reader's. */
export function formatDateTime(value: string | Date, locale: Locale): string {
  return `${dateTimeFormatter(locale).format(new Date(value))} UTC`
}

const relativeFormatters = new Map<Locale, Intl.RelativeTimeFormat>()

/**
 * "in 2 hours" / "dans 2 heures", picking the largest unit that still says something useful.
 *
 * Unlike the formatters above this one depends on the current time, so it is **not**
 * hydration-safe: server and client render it milliseconds apart and eventually disagree.
 * Call it from an effect after mount, never during the first render — the absolute time is
 * what belongs in the server-rendered markup.
 */
export function formatRelativeTime(value: string | Date, locale: Locale, now: Date = new Date()): string {
  let formatter = relativeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(BCP47[locale], { numeric: "auto" })
    relativeFormatters.set(locale, formatter)
  }

  const minutes = Math.round((new Date(value).getTime() - now.getTime()) / 60_000)
  // Coarse on purpose, and always rounded towards the unit below: "in 2 hours" for something
  // 40 minutes away would be a worse answer than "in 40 minutes".
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute")
  if (Math.abs(minutes) < 48 * 60) return formatter.format(Math.trunc(minutes / 60), "hour")
  return formatter.format(Math.trunc(minutes / (60 * 24)), "day")
}
