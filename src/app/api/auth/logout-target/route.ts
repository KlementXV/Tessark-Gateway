import { getToken } from "next-auth/jwt"
import { NextResponse } from "next/server"

import { auth } from "@/auth"
import { logoutRedirectUrl } from "@/lib/auth/oidc-logout"
import { getConfig } from "@/lib/config"

// Asked by signOutTo() *before* the session is cleared — which is the whole point. Ending the
// session at the identity provider needs the ID token from that very session, and once
// NextAuth has dropped the cookie it is gone. So the browser resolves its destination first,
// signs out second, and navigates last.
//
// A static segment takes precedence over the [...nextauth] catch-all beside it, so this
// neither shadows nor is shadowed by the NextAuth handlers.
export async function GET(request: Request) {
  const config = getConfig()
  // AUTH_URL is authoritative behind an Ingress, where the request's own origin is the
  // internal service address and would send the user somewhere unreachable.
  const origin = config.authUrl ?? new URL(request.url).origin

  // No session means nothing to end at the provider either — and it stops this route from
  // being a way for an anonymous caller to make the server fetch a discovery document.
  if (!(await auth())) {
    return NextResponse.json({ url: new URL("/login", origin).toString() })
  }

  const idTokenHint = config.oidcLogoutMode === "idp" ? await readIdToken(request) : undefined
  return NextResponse.json({ url: await logoutRedirectUrl(config, origin, idTokenHint) })
}

/**
 * Pulls the stored ID token back out of the session cookie. It lives in the JWT rather than
 * the session object because the session is serialized to the browser and a provider token
 * has no business going there — so `auth()` cannot reach it and the cookie has to be decoded
 * directly. Undefined whenever it was never stored, which is every mode but `idp`.
 */
async function readIdToken(request: Request): Promise<string | undefined> {
  const { authSecret, authUrl } = getConfig()
  // NextAuth prefixes the cookie with `__Secure-` on an https deployment. Rather than infer
  // that from a request URL which is plain http behind an Ingress, try the derived name and
  // then the other one: a wrong guess would silently cost the id_token_hint.
  const preferSecure = (authUrl ?? request.url).startsWith("https://")

  for (const secureCookie of [preferSecure, !preferSecure]) {
    const token = await getToken({ req: request, secret: authSecret, secureCookie })
    if (typeof token?.idToken === "string") return token.idToken
  }
  return undefined
}
