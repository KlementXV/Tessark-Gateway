import { randomBytes } from "node:crypto"

import { hashPassword } from "@/lib/crypto"

// A token looks like tsk_live_<8-char prefix><32-char secret>, e.g.
// tsk_live_ab12cd34Ef... — the prefix is stored in the clear (ApiToken.tokenPrefix) so a
// lookup by prefix is O(1); the secret is never stored, only its scrypt hash
// (ApiToken.tokenHash), verified the same way as a user password (see crypto.ts).
const TOKEN_STATIC_PREFIX = "tsk_live_"
const PREFIX_BYTES = 6 // base64url(6 bytes) = 8 chars, no padding (6 is a multiple of 3)
const SECRET_BYTES = 24 // base64url(24 bytes) = 32 chars (~192 bits of entropy)

export interface GeneratedApiToken {
  /** Full token string — shown to the caller exactly once, never persisted in this form. */
  token: string
  tokenPrefix: string
  tokenHash: string
}

export function generateApiToken(): GeneratedApiToken {
  const tokenPrefix = randomBytes(PREFIX_BYTES).toString("base64url")
  const secret = randomBytes(SECRET_BYTES).toString("base64url")
  return {
    token: `${TOKEN_STATIC_PREFIX}${tokenPrefix}${secret}`,
    tokenPrefix,
    tokenHash: hashPassword(secret),
  }
}

/** Splits a raw `Authorization: Bearer <token>` value back into its lookup and secret halves. */
export function splitApiToken(rawToken: string): { tokenPrefix: string; secret: string } | null {
  if (!rawToken.startsWith(TOKEN_STATIC_PREFIX)) return null
  const rest = rawToken.slice(TOKEN_STATIC_PREFIX.length)
  const tokenPrefix = rest.slice(0, 8)
  const secret = rest.slice(8)
  if (tokenPrefix.length !== 8 || secret.length !== 32) return null
  return { tokenPrefix, secret }
}
