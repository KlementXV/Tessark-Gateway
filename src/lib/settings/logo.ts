// Validation for uploaded brand logos. The client-declared Content-Type is never
// trusted — the bytes are sniffed and the detected type is what gets stored and
// later served back.
//
// The size cap is configurable (LOGO_MAX_BYTES in src/lib/config.ts) and this module is
// shared with client components (the branding form), so it can't read config itself —
// callers pass the limit in explicitly instead of this module reaching for a constant.

/** Path the branding form points `logoUrl` at once a file has been uploaded. */
export const UPLOADED_LOGO_PATH = "/api/settings/branding/logo"

export const ACCEPTED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon"] as const

export type LogoMimeType = (typeof ACCEPTED_LOGO_TYPES)[number]

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte)
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/**
 * Detects the image type from magic bytes. Returns null for anything that isn't a
 * format we serve — including a renamed executable with an image extension.
 */
export function sniffLogoMimeType(bytes: Uint8Array): LogoMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "image/webp"
  if (asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a") return "image/gif"
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon"

  // SVG is text: skip a BOM, an XML declaration, comments and whitespace, then
  // require an actual <svg root element.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 2048))
    .replace(/^﻿/, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .trim()
  if (/^<svg[\s>]/i.test(head)) return "image/svg+xml"

  return null
}

export interface LogoValidationError {
  message: string
}

export function validateLogoBytes(
  bytes: Uint8Array,
  maxBytes: number,
): { ok: true; mimeType: LogoMimeType } | { ok: false; error: LogoValidationError } {
  if (bytes.byteLength === 0) {
    return { ok: false, error: { message: "The uploaded file is empty" } }
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      error: { message: `Logo must be ${Math.round(maxBytes / 1024)} KB or smaller` },
    }
  }

  const mimeType = sniffLogoMimeType(bytes)
  if (!mimeType) {
    return { ok: false, error: { message: "Unsupported image format — use PNG, JPEG, WebP, GIF, SVG or ICO" } }
  }

  return { ok: true, mimeType }
}

/** Cache-busting pointer stored in `logoUrl` so a re-upload isn't masked by a cached response. */
export function uploadedLogoUrl(version: Date): string {
  return `${UPLOADED_LOGO_PATH}?v=${version.getTime()}`
}

export function isUploadedLogoUrl(url: string | null): boolean {
  return url !== null && url.split("?")[0] === UPLOADED_LOGO_PATH
}
