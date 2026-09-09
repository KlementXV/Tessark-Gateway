// Validation for user-uploaded profile pictures. Same shape as the branding logo
// (src/lib/settings/logo.ts) — the client-declared Content-Type is never trusted, the
// bytes are sniffed and the detected type is what gets stored and served back.
//
// Two deliberate differences from the logo:
//   - SVG is not accepted. A logo is uploaded by a SUPERADMIN, an avatar by any user,
//     and SVG is active content — keeping it out means the avatar route only ever serves
//     inert raster bytes.
//   - The size cap is lower: an avatar is rendered at 96px at most.
//
// The size cap is configurable (AVATAR_MAX_BYTES in src/lib/config.ts) and this module is
// shared with client components (the profile form), so it can't read config itself —
// callers pass the limit in explicitly instead of this module reaching for a constant.

import { sniffLogoMimeType } from "@/lib/settings/logo"

export const ACCEPTED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const

export type AvatarMimeType = (typeof ACCEPTED_AVATAR_TYPES)[number]

function isAcceptedAvatarType(mimeType: string): mimeType is AvatarMimeType {
  return (ACCEPTED_AVATAR_TYPES as readonly string[]).includes(mimeType)
}

export function validateAvatarBytes(
  bytes: Uint8Array,
  maxBytes: number,
): { ok: true; mimeType: AvatarMimeType } | { ok: false; error: string } {
  if (bytes.byteLength === 0) {
    return { ok: false, error: "The uploaded file is empty" }
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: `Picture must be ${Math.round(maxBytes / 1024)} KB or smaller` }
  }

  const mimeType = sniffLogoMimeType(bytes)
  if (!mimeType || !isAcceptedAvatarType(mimeType)) {
    return { ok: false, error: "Unsupported image format — use PNG, JPEG, WebP or GIF" }
  }

  return { ok: true, mimeType }
}

/**
 * Where a user's avatar is served from. The `?v=` stamp changes on every upload, so the
 * bytes behind a given URL are immutable and the route can cache aggressively.
 */
export function avatarUrl(userId: string, version: Date | null): string | null {
  return version ? `/api/users/${userId}/avatar?v=${version.getTime()}` : null
}
