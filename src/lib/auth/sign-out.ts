"use client"

import { signOut } from "next-auth/react"

/**
 * Resolve the destination while the session still carries the provider's ID token, clear
 * the Gateway session, then navigate. The server decides whether provider logout is enabled.
 * A failed target lookup must still allow local sign-out.
 */
export async function signOutTo(): Promise<void> {
  let destination = "/login"
  try {
    const response = await fetch("/api/auth/logout-target", {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) {
      const body = await response.json() as { url?: unknown } | null
      if (typeof body?.url === "string" && body.url) {
        const url = new URL(body.url, window.location.href)
        if (url.protocol === "https:" || url.protocol === "http:") destination = url.toString()
      }
    }
  } catch {
    // Discovery or the target route may be unavailable; the local session still has to end.
  }

  // Auth.js restricts callback redirects to this origin. The provider URL is resolved by our
  // server above and must be visited separately, once its session cookie has been cleared.
  await signOut({ redirect: false, redirectTo: "/login" })
  window.location.assign(destination)
}
