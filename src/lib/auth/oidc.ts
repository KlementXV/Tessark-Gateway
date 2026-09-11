// Everything specific to signing in through an OpenID Connect provider, kept out of
// src/auth.ts so it can be reasoned about (and exercised) without booting NextAuth.
//
// Two rules shape this file:
//
//  1. **Identity is the `sub` claim, never the email.** An email is mutable and not always
//     verified by the provider, so matching on one would let a compromised or re-issued
//     mailbox take over an existing account. The stored key is `<issuer>|<sub>`, namespaced
//     so two providers cannot collide on a short subject like "1".
//  2. **A configured mapping makes the provider own the role.** A nonempty OIDC_ROLE_MAPPING
//     is re-applied at every sign-in; otherwise existing roles remain managed in Gateway. The
//     one thing it may not do is leave the instance with no active SUPERADMIN — an operator
//     who mis-maps a group must not be able to lock everyone out of user administration.
import { Prisma, Role, type User } from "@/generated/prisma/client"
import { highestRole } from "@/lib/auth/role-rank"
import type { Config } from "@/lib/config"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { isLastActiveSuperadmin } from "@/lib/users/superadmin"
import type { OIDCConfig } from "next-auth/providers"

export const OIDC_PROVIDER_ID = "oidc"
/** Value written to User.authProvider for accounts mastered by the identity provider. */
export const OIDC_AUTH_PROVIDER = "oidc"

/**
 * Reasons a sign-in is refused, as stable codes rather than sentences: NextAuth puts them
 * straight into `?error=` on the login page, where the UI translates them. Anything not
 * listed here reaches the user as the generic failure message.
 */
export type OidcRefusalCode =
  | "OidcAccountExists"
  | "OidcEmailUnverified"
  | "OidcSignupDisabled"
  | "OidcAccountDisabled"
  | "OidcMissingSubject"

export class OidcRefusal extends Error {
  constructor(readonly code: OidcRefusalCode) {
    super(code)
    this.name = "OidcRefusal"
  }
}

/** The subset of the ID token / userinfo claims this module reads. */
export interface OidcClaims {
  sub?: unknown
  email?: unknown
  email_verified?: unknown
  name?: unknown
  preferred_username?: unknown
  [claim: string]: unknown
}

/**
 * Provider definition handed to NextAuth. Only the issuer is configured: the authorization,
 * token, userinfo, JWKS and end-session endpoints all come from
 * `<issuer>/.well-known/openid-configuration`, which is what makes this work against
 * Dex through standard OIDC discovery, regardless of its upstream connectors.
 */
export function oidcProvider(config: Config): OIDCConfig<OidcClaims> {
  // getConfig() already refuses OIDC_ENABLED without an issuer and a client id, so these are
  // present by construction — the check keeps that guarantee local and typed rather than
  // implied from another file.
  if (!config.oidcIssuer || !config.oidcClientId) {
    throw new Error("OIDC is enabled but OIDC_ISSUER / OIDC_CLIENT_ID are missing")
  }

  return {
    id: OIDC_PROVIDER_ID,
    name: config.oidcDisplayName,
    type: "oidc",
    issuer: config.oidcIssuer,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    authorization: { params: { scope: config.oidcScopes } },
    // PKCE on top of the client secret: harmless for a confidential client, and the only
    // protection left if the deployment runs the client as public (no secret).
    checks: ["pkce", "state"],
    // Shapes the claims into NextAuth's User. It is *not* where authorization is decided:
    // upsertOidcUser re-derives the role against the database row, and the session is built
    // from that row — nothing here is trusted straight through.
    profile: (claims) => ({
      id: String(claims.sub ?? ""),
      name: typeof claims.name === "string" ? claims.name : null,
      email: typeof claims.email === "string" ? claims.email : null,
      role: resolveRole(claims, config),
    }),
  }
}

/** Reads a configured dotted path out of the claim object. */
function claimAtPath(claims: OidcClaims, path: string): unknown {
  return path.split(".").reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== "object") return undefined
    return (node as Record<string, unknown>)[segment]
  }, claims)
}

/**
 * Maps the provider's group/role claim onto a Gateway Role. The highest match wins, so a
 * user in both `gateway-admins` and `gateway-owners` gets the more privileged of the two;
 * nothing matching falls back to OIDC_DEFAULT_ROLE.
 */
export function resolveRole(claims: OidcClaims, config: Config): Role {
  const raw = claimAtPath(claims, config.oidcRoleClaim)
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]

  const matched = values
    .filter((value): value is string => typeof value === "string")
    // Match the exact claim value; distinct directory group names stay distinct.
    .map((value) => Object.hasOwn(config.oidcRoleMapping, value) ? config.oidcRoleMapping[value] : undefined)
    .filter((role): role is Role => role !== undefined)

  return highestRole(matched, config.oidcDefaultRole)
}

/**
 * Picks a username for a freshly provisioned account. `username` carries a unique
 * constraint and a 3–40 character rule (userCreateInputSchema), so the claim is normalized
 * into that shape and then suffixed until it is free.
 */
export async function deriveUsername(claims: OidcClaims): Promise<string> {
  const preferred =
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    (typeof claims.email === "string" && claims.email.split("@")[0]) ||
    (typeof claims.sub === "string" && claims.sub) ||
    "user"

  const base =
    preferred
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34) || "user"
  // Below the schema's 3-character floor after normalization — pad rather than fail.
  const seed = base.length >= 3 ? base : `${base}-user`.slice(0, 34)

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`
    const taken = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } })
    if (!taken) return candidate
  }
  // 50 collisions on the same normalized name means something is wrong upstream; a random
  // suffix is still better than refusing the sign-in.
  return `${seed}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Resolves the OIDC claims to a database row, provisioning or updating it as configured.
 * Throws {@link OidcRefusal} rather than returning null so the caller can surface *why*.
 */
export async function upsertOidcUser(claims: OidcClaims, config: Config): Promise<User> {
  const sub = typeof claims.sub === "string" ? claims.sub : null
  if (!sub) throw new OidcRefusal("OidcMissingSubject")

  const externalId = `${config.oidcIssuer}|${sub}`
  const email = typeof claims.email === "string" ? claims.email.trim() : null
  const name = typeof claims.name === "string" ? claims.name.trim() || null : null
  const role = resolveRole(claims, config)
  const roleMapped = Object.keys(config.oidcRoleMapping).length > 0

  const existing = await prisma.user.findUnique({ where: { externalId } })

  if (existing) {
    if (existing.disabled) {
      // Disabling an account in the Gateway is the local emergency stop; a valid token from
      // the provider must not override it.
      logger.warn("OIDC sign-in refused", { sub, reason: "account disabled", userId: existing.id })
      throw new OidcRefusal("OidcAccountDisabled")
    }

    const wouldDemoteLastSuperadmin =
      roleMapped && existing.role === Role.SUPERADMIN && role !== Role.SUPERADMIN && (await isLastActiveSuperadmin(existing.id))

    if (wouldDemoteLastSuperadmin) {
      logger.warn("Kept SUPERADMIN role against the OIDC role mapping: demoting would leave no active superadmin", {
        userId: existing.id,
        mappedRole: role,
      })
    }

    return prisma.user.update({
      where: { id: existing.id },
      data: {
        // The provider is the source of truth for identity and role, but only for fields it
        // actually supplied: a token without an email claim must not blank a stored one.
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        ...(roleMapped ? { role: wouldDemoteLastSuperadmin ? existing.role : role } : {}),
      },
    })
  }

  // First sight of this subject. Anything already occupying its email is, by definition, a
  // different account — adopting it is only ever allowed deliberately.
  const collision = email ? await prisma.user.findUnique({ where: { email } }) : null

  if (collision) {
    if (!config.oidcLinkByEmail || collision.authProvider !== "local" || collision.externalId !== null) {
      logger.warn("OIDC sign-in refused", { sub, reason: "email already belongs to another account" })
      throw new OidcRefusal("OidcAccountExists")
    }
    if (claims.email_verified !== true) {
      logger.warn("OIDC sign-in refused", { sub, reason: "linking requires a verified email" })
      throw new OidcRefusal("OidcEmailUnverified")
    }
    if (collision.disabled) {
      logger.warn("OIDC sign-in refused", { sub, reason: "linked account disabled", userId: collision.id })
      throw new OidcRefusal("OidcAccountDisabled")
    }

    const keepRole =
      roleMapped && collision.role === Role.SUPERADMIN && role !== Role.SUPERADMIN && (await isLastActiveSuperadmin(collision.id))

    let linked: User
    try {
      linked = await prisma.user.update({
        // Recheck at write time: another sign-in may have linked this account since the read.
        where: { id: collision.id, authProvider: "local", disabled: false, AND: { externalId: null } },
        data: {
          externalId,
          authProvider: OIDC_AUTH_PROVIDER,
          // Linking removes the credentials path into the newly federated account.
          passwordHash: null,
          ...(name ? { name } : {}),
          ...(roleMapped ? { role: keepRole ? collision.role : role } : {}),
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new OidcRefusal("OidcAccountExists")
      }
      throw err
    }
    logger.info("Linked an existing local account to its OIDC identity", { userId: collision.id, sub })
    return linked
  }

  if (!config.oidcAllowSignup) {
    logger.warn("OIDC sign-in refused", { sub, reason: "just-in-time provisioning disabled" })
    throw new OidcRefusal("OidcSignupDisabled")
  }

  const username = await deriveUsername(claims)

  try {
    const created = await prisma.user.create({
      data: {
        externalId,
        authProvider: OIDC_AUTH_PROVIDER,
        passwordHash: null,
        // No email claim is unusual but not fatal: synthesize a stable local address rather
        // than refuse, since `email` is unique and non-null on the model.
        email: email ?? `${username}@${OIDC_AUTH_PROVIDER}.local`,
        username,
        name,
        role,
      },
    })
    logger.info("Provisioned a user from OIDC", { userId: created.id, sub, role })
    return created
  } catch (err) {
    // Two concurrent first sign-ins for the same subject: the loser re-reads the row the
    // winner just wrote instead of failing the login.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await prisma.user.findUnique({ where: { externalId } })
      if (raced) return raced
    }
    throw err
  }
}
