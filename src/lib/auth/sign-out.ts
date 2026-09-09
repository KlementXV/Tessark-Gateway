"use client"

import { signOut } from "next-auth/react"

/**
 * The single sign-out entry point for the UI. Everything routes through /api/auth/
 * federated-logout rather than straight to /login: NextAuth clears the session cookie first,
 * then that route decides — from OIDC_LOGOUT_MODE, which only the server knows — whether the
 * identity provider session ends too. Keeping the decision server-side means no sign-out
 * button has to be told how this instance is configured.
 */
export function signOutTo(): Promise<void> {
  return signOut({ callbackUrl: "/api/auth/federated-logout" })
}
