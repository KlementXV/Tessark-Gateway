// Everything locale-related that is safe to import from the client: the list of supported
// languages, the cookie that persists the choice, and the Accept-Language negotiation.
// The server-only resolver lives in request.ts; the cookie writer in actions.ts.

export const SUPPORTED_LOCALES = ["en", "fr"] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** Persists the visitor's explicit choice. Not httpOnly: it carries no secret. */
export const LOCALE_COOKIE = "gateway_locale"
/** One year — a language preference has no reason to expire sooner than the session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Label of each language, written in that language so it is readable whatever is active. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  fr: "Français",
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * First supported language in an `Accept-Language` header, honouring the q-weights and
 * matching "fr-CA" to "fr". Null when nothing matches — the caller falls back to the
 * instance default rather than to a hard-coded language.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";")
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
      const weight = q ? Number(q.slice(2)) : 1
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)

  for (const { tag } of ranked) {
    const base = tag.split("-")[0]
    if (isLocale(base)) return base
  }
  return null
}

/**
 * Browser-side read of the locale cookie, for the one place that renders outside the
 * next-intl provider (app/global-error.tsx). Null on the server or when unset.
 */
export function readLocaleCookie(): Locale | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`))
  const value = match ? decodeURIComponent(match[1]) : null
  return isLocale(value) ? value : null
}
