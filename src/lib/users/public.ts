import type { User } from "@/generated/prisma/client"

import { avatarUrl } from "@/lib/users/avatar"
import { LOCAL_AUTH_PROVIDER } from "@/lib/users/profile"

// Strips passwordHash before anything crosses the wire — same reasoning as
// registries/public.ts stripping encryptedSecret. The avatar blob is dropped for a
// different reason: it is no secret, but shipping a few hundred KB of image bytes with
// every user listing is pure waste — callers get `avatarUrl` instead and fetch it from
// the avatar route, which caches it.
export function toPublicUser(user: User) {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars -- destructured only to exclude them */
    passwordHash: _passwordHash,
    avatarData: _avatarData,
    avatarMimeType: _avatarMimeType,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...rest
  } = user

  return {
    ...rest,
    avatarUrl: avatarUrl(user.id, user.avatarUpdatedAt),
    // Derived here rather than left to each caller comparing `authProvider` to a string
    // literal: whether an account is mastered elsewhere drives what the admin UI may offer,
    // and that question should have exactly one answer.
    federated: user.authProvider !== LOCAL_AUTH_PROVIDER,
  }
}

export type PublicUser = ReturnType<typeof toPublicUser>
