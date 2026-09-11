// Authentication entry point. Two providers, both optional at runtime:
//
//   - `credentials`  — username/password checked against the User table. This is the
//     break-glass path: it stays available even when SSO is on, so an unreachable identity
//     provider never locks the bootstrapped SUPERADMIN out of their own instance.
//   - `oidc`         — Dex, discovered from its issuer (LDAP/AD and/or upstream OIDC
//     authentication). All of its logic lives in src/lib/auth/oidc.ts.
//
// The configuration is built **lazily**. Reading getConfig() at module load would make
// `next build` require a full environment, which CLAUDE.md §0.1 forbids; NextAuth accepts a
// factory for exactly this. getConfig() is memoized, so the per-request cost is a map lookup.
//
// Nothing about the session shape changes with SSO on: callers still see `{ id, role }` and
// go through auth()/requireRole(). No provider token is stored — the Gateway never calls an
// API on the user's behalf, so keeping their access token would be a leak with no upside.
import NextAuth, { type NextAuthConfig } from "next-auth"
import Credentials from "next-auth/providers/credentials"

import { verifyLocalCredentials } from "@/lib/auth/credentials"
import {
  OIDC_PROVIDER_ID,
  OidcRefusal,
  oidcProvider,
  upsertOidcUser,
  type OidcClaims,
} from "@/lib/auth/oidc"
import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"

const credentialsProvider = Credentials({
  name: "Credentials",
  credentials: {
    username: { label: "Username", type: "text" },
    password: { label: "Password", type: "password" },
  },
  async authorize(credentials) {
    const { username, password } = credentials ?? {}
    if (typeof username !== "string" || typeof password !== "string") return null

    const user = await verifyLocalCredentials(username, password)
    if (!user) return null

    return { id: user.id, name: user.name ?? user.username, email: user.email, role: user.role }
  },
})

function buildConfig(): NextAuthConfig {
  const config = getConfig()

  return {
    providers: [
      ...(config.oidcAllowLocalLogin ? [credentialsProvider] : []),
      ...(config.oidcEnabled ? [oidcProvider(config)] : []),
    ],
    pages: {
      signIn: "/login",
    },
    session: { strategy: "jwt" },
    callbacks: {
      // Runs before the JWT is minted, and is the only hook that can refuse a sign-in with a
      // reason: returning a URL redirects there, so each refusal code reaches /login intact
      // instead of collapsing into a generic AccessDenied.
      async signIn({ account, profile }) {
        if (account?.provider !== OIDC_PROVIDER_ID) return true

        try {
          await upsertOidcUser(profile as OidcClaims, config)
          return true
        } catch (err) {
          if (err instanceof OidcRefusal) return `/login?error=${err.code}`
          throw err
        }
      },

      async jwt({ token, user, account, profile }) {
        if (account?.provider === OIDC_PROVIDER_ID) {
          // signIn() has just written the row; re-read it so the session carries the
          // Gateway's own id and role rather than anything taken from the token claims.
          const sub = (profile as OidcClaims | undefined)?.sub
          const row = await prisma.user.findUnique({
            where: { externalId: `${config.oidcIssuer}|${String(sub)}` },
            select: { id: true, role: true },
          })
          if (!row) return null
          token.id = row.id
          token.role = row.role
          token.checkedAt = Date.now()
          // Only in `idp` mode, and only for the sake of the end-session request: providers
          // differ on whether `client_id` alone is enough to accept a post-logout redirect,
          // and Okta documents `id_token_hint` as the way. Storing it in any other mode would
          // be carrying a token nothing reads.
          if (config.oidcLogoutMode === "idp") token.idToken = account.id_token
          return token
        }

        if (user) {
          token.id = user.id!
          token.role = user.role
          token.checkedAt = Date.now()
          return token
        }

        // Re-read the role and the disabled flag periodically. Without this a demoted or
        // disabled user keeps their access for the lifetime of the JWT — API tokens already
        // resolve their owner live (resolveApiToken), and sessions should not be weaker.
        const checkedAt = typeof token.checkedAt === "number" ? token.checkedAt : 0
        const maxAgeMs = config.authSessionRefreshSeconds * 1000
        if (Date.now() - checkedAt < maxAgeMs) return token

        const fresh = await prisma.user.findUnique({
          where: { id: token.id },
          select: { role: true, disabled: true },
        })
        // Deleted or disabled since the JWT was issued: returning null invalidates the
        // session rather than letting it run to its natural expiry.
        if (!fresh || fresh.disabled) return null

        token.role = fresh.role
        token.checkedAt = Date.now()
        return token
      },

      session({ session, token }) {
        session.user.id = token.id
        session.user.role = token.role
        return session
      },
    },
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth(buildConfig)
