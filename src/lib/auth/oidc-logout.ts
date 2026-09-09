// RP-initiated logout (OIDC Core §5, "RP-Initiated Logout"). Signing out of the Gateway only
// clears the Gateway's own cookie; the session at the identity provider survives, so pressing
// "sign in" again returns the user straight in with no prompt. That surprises people, but the
// alternative — ending the provider session — signs them out of *every* application in the
// realm, which is not a decision this application gets to make for an operator. Hence
// OIDC_LOGOUT_MODE, defaulting to the local-only behaviour.
import type { Config } from "@/lib/config"
import { logger } from "@/lib/logger"

// Fixed rather than configurable: this one request is on the logout path, its failure is
// already handled (fall back to a local sign-out), and no installation needs to tune it.
const DISCOVERY_TIMEOUT_MS = 5000

interface DiscoveryDocument {
  end_session_endpoint?: unknown
}

/**
 * Where to send the browser after the session cookie has been cleared: the provider's
 * end-session endpoint when RP-initiated logout is configured and supported, otherwise the
 * local login page. Never throws — a logout must complete even with the provider down.
 *
 * `idTokenHint` is the ID token from the session being ended. The spec makes it merely
 * RECOMMENDED — `client_id` alone is the documented substitute — but it also lets a provider
 * refuse the post-logout redirect without it, and Okta's own documentation only ever shows
 * the `id_token_hint` form. Sending both is what works everywhere.
 */
export async function logoutRedirectUrl(
  config: Config,
  origin: string,
  idTokenHint?: string,
): Promise<string> {
  const loginUrl = new URL("/login", origin).toString()

  if (!config.oidcEnabled || config.oidcLogoutMode !== "idp" || !config.oidcIssuer) return loginUrl

  try {
    const discoveryUrl = new URL(".well-known/openid-configuration", `${config.oidcIssuer.replace(/\/$/, "")}/`)
    const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`discovery responded ${response.status}`)

    const { end_session_endpoint: endpoint } = (await response.json()) as DiscoveryDocument
    if (typeof endpoint !== "string") {
      // Plenty of providers implement OIDC without RP-initiated logout. Not an error, but the
      // operator asked for `idp` and is silently getting `local`, so say so once per logout.
      logger.warn("OIDC_LOGOUT_MODE=idp but the provider advertises no end_session_endpoint")
      return loginUrl
    }

    const endSession = new URL(endpoint)
    endSession.searchParams.set("post_logout_redirect_uri", loginUrl)
    if (config.oidcClientId) endSession.searchParams.set("client_id", config.oidcClientId)
    if (idTokenHint) endSession.searchParams.set("id_token_hint", idTokenHint)
    return endSession.toString()
  } catch (err) {
    logger.warn("Falling back to a local sign-out: could not read the OIDC discovery document", {
      reason: err instanceof Error ? err.message : String(err),
    })
    return loginUrl
  }
}
