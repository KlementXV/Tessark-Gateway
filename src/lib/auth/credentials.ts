// The local username/password check, split out of src/auth.ts for the same reason
// upsertOidcUser is: it is the other half of the sign-in decision, and it should be
// readable — and exercisable — without booting NextAuth around it.
import type { User } from "@/generated/prisma/client"
import { verifyPassword } from "@/lib/crypto"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { LOCAL_AUTH_PROVIDER } from "@/lib/users/profile"

/**
 * Resolves a username/password pair to a user, or null if it does not authenticate. The
 * caller never learns *which* rule refused — that distinction stays in the logs, since
 * telling an anonymous visitor whether an account exists, is disabled, or is federated is
 * telling them something they should not know.
 */
export async function verifyLocalCredentials(username: string, password: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { username } })

  if (!user || user.disabled) {
    // Username, not password — a username is not a secret, and knowing which login was
    // attempted is what makes this log line useful for spotting brute-forcing.
    logger.warn("Authentication failed", { username, reason: !user ? "unknown user" : "disabled" })
    return null
  }

  // A federated account has no password of ours to check. Refusing on authProvider as well
  // as on a null hash matters: an account linked to an identity provider after the fact must
  // not stay reachable through whatever hash it used to carry.
  if (user.authProvider !== LOCAL_AUTH_PROVIDER || !user.passwordHash) {
    logger.warn("Authentication failed", { username, reason: "federated account" })
    return null
  }

  if (!verifyPassword(password, user.passwordHash)) {
    logger.warn("Authentication failed", { username, reason: "wrong password" })
    return null
  }

  return user
}
