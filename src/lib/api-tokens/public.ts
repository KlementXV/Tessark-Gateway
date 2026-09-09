import type { ApiToken } from "@/generated/prisma/client"

// Strips tokenHash before anything crosses the wire — same reasoning as
// registries/public.ts stripping encryptedSecret. tokenPrefix is safe to expose: it's how a
// user recognizes which token is which without ever seeing the secret again.
export function toPublicApiToken(token: ApiToken) {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars -- destructured only to exclude it */
    tokenHash: _tokenHash,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...rest
  } = token

  return rest
}

export type PublicApiToken = ReturnType<typeof toPublicApiToken>
