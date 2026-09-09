"use server"

// Persists the language picked in the UI. A Server Action rather than a client-side
// `document.cookie` write so the choice is applied by the very next server render
// (router.refresh()) with no flash of the previous language.
import { cookies } from "next/headers"

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/i18n/locale"

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  })
}
