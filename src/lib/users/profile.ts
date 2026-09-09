// Self-service account settings: the profile the signed-in user sees and edits on
// /settings, as opposed to the SUPERADMIN user administration under /settings/users.
//
// Everything here hangs off one rule: a user may only rewrite the fields the Gateway
// actually owns. For a `local` account that is email, username, display name and
// password, all stored on the User row. For an account mastered by an external directory
// (LDAP/OIDC — see User.authProvider in prisma/schema.prisma) those fields are a cached
// copy of the directory's data, so they are exposed read-only and the write helpers below
// refuse them. The avatar is exempt: it is Gateway-local decoration nobody else masters.
import { cache } from "react"

import { OIDC_AUTH_PROVIDER } from "@/lib/auth/oidc"
import { getConfig } from "@/lib/config"
import { hashPassword, verifyPassword } from "@/lib/crypto"
import { prisma } from "@/lib/prisma"
import { avatarUrl } from "@/lib/users/avatar"
import { AuthError } from "@/lib/auth/guard"
import type { Role } from "@/generated/prisma/client"

export const LOCAL_AUTH_PROVIDER = "local"

export interface UserProfile {
  id: string
  username: string
  email: string
  name: string | null
  role: Role
  authProvider: string
  /** False for directory-mastered accounts: identity and password are not ours to change. */
  credentialsEditable: boolean
  /**
   * What to call the directory in the UI — OIDC_DISPLAY_NAME rather than the bare "oidc",
   * so a user reads "Managed by Acme SSO" and not a schema value. Null for local accounts.
   * Resolved here because the label lives in server config the client never sees.
   */
  providerLabel: string | null
  avatarUrl: string | null
  createdAt: Date
}

function providerLabel(authProvider: string): string | null {
  if (authProvider === LOCAL_AUTH_PROVIDER) return null
  return authProvider === OIDC_AUTH_PROVIDER ? getConfig().oidcDisplayName : authProvider
}

function toProfile(user: {
  id: string
  username: string
  email: string
  name: string | null
  role: Role
  authProvider: string
  avatarUpdatedAt: Date | null
  createdAt: Date
}): UserProfile {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
    authProvider: user.authProvider,
    credentialsEditable: user.authProvider === LOCAL_AUTH_PROVIDER,
    providerLabel: providerLabel(user.authProvider),
    avatarUrl: avatarUrl(user.id, user.avatarUpdatedAt),
    createdAt: user.createdAt,
  }
}

/**
 * The stored profile for a session's user.
 *
 * Read from the database rather than from the JWT on purpose: the session token is minted
 * at login and still carries the old name/email/avatar right after the user edits them.
 * Both the sidebar and the settings page go through here so a save is visible immediately,
 * without forcing a re-login. `cache` collapses the repeat reads within one request.
 */
export const getUserProfile = cache(async (userId: string): Promise<UserProfile | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      role: true,
      authProvider: true,
      avatarUpdatedAt: true,
      createdAt: true,
    },
  })
  return user ? toProfile(user) : null
})

/** Throws unless the account is one whose credentials the Gateway itself stores. */
async function requireLocalAccount(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { authProvider: true } })
  if (!user) throw new AuthError("Account not found", 404)
  if (user.authProvider !== LOCAL_AUTH_PROVIDER) {
    throw new AuthError(
      "This account is managed by your identity provider — change these details there.",
      409,
    )
  }
}

export interface ProfileUpdate {
  name: string | null
  email: string
  username: string
}

export async function updateUserProfile(userId: string, data: ProfileUpdate): Promise<UserProfile> {
  await requireLocalAccount(userId)

  try {
    const user = await prisma.user.update({ where: { id: userId }, data })
    return toProfile(user)
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      throw new AuthError("That email address or username is already taken.", 409)
    }
    throw err
  }
}

/**
 * Rotates the password after re-authenticating with the current one. The check is what
 * keeps a borrowed session from being upgraded into permanent account takeover, so it
 * applies to every caller — a SUPERADMIN changing *their own* password included. (Resetting
 * *someone else's* password is a different operation and stays on PATCH /api/users/[id].)
 */
export async function changeUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await requireLocalAccount(userId)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  if (!user) throw new AuthError("Account not found", 404)
  // requireLocalAccount above already guarantees a local account, and a local account always
  // has a hash — this narrows the nullable column rather than guarding a reachable case.
  if (!user.passwordHash || !verifyPassword(currentPassword, user.passwordHash)) {
    throw new AuthError("Your current password is incorrect.", 400)
  }

  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(newPassword) } })
}

export async function saveUserAvatar(
  userId: string,
  data: Uint8Array,
  mimeType: string,
): Promise<UserProfile> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { avatarData: Buffer.from(data), avatarMimeType: mimeType, avatarUpdatedAt: new Date() },
  })
  return toProfile(user)
}

export async function deleteUserAvatar(userId: string): Promise<UserProfile> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { avatarData: null, avatarMimeType: null, avatarUpdatedAt: null },
  })
  return toProfile(user)
}

/** Raw bytes for the avatar route — kept out of `getUserProfile` so the blob never rides
 *  along in the RSC payload of every page render. */
export async function getUserAvatar(
  userId: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { avatarData: true, avatarMimeType: true },
  })
  if (!user?.avatarData || !user.avatarMimeType) return null
  return { data: Buffer.from(user.avatarData), mimeType: user.avatarMimeType }
}
