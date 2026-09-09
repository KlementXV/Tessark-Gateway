// next-intl's request-scoped resolver (wired by createNextIntlPlugin in next.config.ts).
// No locale in the URL: the app is a private console behind a login, not a marketing site,
// so the language is a per-visitor preference — cookie first, then the browser's
// Accept-Language, then the instance default (DEFAULT_LOCALE) — never a routing concern.
import { getRequestConfig } from "next-intl/server"
import { cookies, headers } from "next/headers"

import { getConfig } from "@/lib/config"
import { isLocale, LOCALE_COOKIE, negotiateLocale, type Locale } from "@/i18n/locale"

export async function resolveLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value
  if (isLocale(fromCookie)) return fromCookie
  return negotiateLocale(headerStore.get("accept-language")) ?? getConfig().defaultLocale
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // Dates are rendered in UTC on both sides of the wire (see src/lib/format-date.ts) so
    // that server and client HTML agree — the reader's zone is deliberately not used.
    timeZone: "UTC",
  }
})
