// Pure branding helpers — no DB, no React. Shared by the server (layout, API route)
// and the client (branding form preview), so keep this module dependency-free.

export interface InstanceBranding {
  brandName: string
  brandTagline: string
  logoUrl: string | null
  primaryColor: string | null
}

/** "Tessark" + "Gateway" -> "Tessark Gateway", tolerating a blank tagline. */
export function brandTitle(branding: Pick<InstanceBranding, "brandName" | "brandTagline">): string {
  return [branding.brandName, branding.brandTagline]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
}

/**
 * Accepts `#abc`, `abc`, `#AABBCC`, `AABBCC` and returns a canonical lowercase
 * `#aabbcc`. Returns null when the value isn't a hex color.
 */
export function normalizeHexColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "").toLowerCase()
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
  }
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null
}

/**
 * Logos are rendered as `<img src>` from an operator-supplied value. Allow only
 * http(s) URLs and same-origin absolute paths — never `javascript:`, `data:` or
 * protocol-relative `//host` values.
 */
export function isSafeLogoUrl(value: string): boolean {
  if (value.startsWith("//")) return false
  // "/\evil.com/x.png" is not a path: browsers normalise the backslash to a slash before
  // resolving, so it leaves the origin exactly as "//" would. No real logo path starts this
  // way, so refusing the pair outright costs nothing.
  if (value.startsWith("/\\")) return false
  if (value.startsWith("/")) return true
  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/** WCAG relative luminance of a `#rrggbb` color. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Text/icon color to pair with `background`, picking whichever of black or white
 * has the higher contrast ratio. Without this, a light brand color (e.g. #fde047)
 * keeps the theme's near-white `--primary-foreground` and the brand mark becomes
 * unreadable.
 */
export function readableForeground(background: string): string {
  const luminance = relativeLuminance(background)
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  const contrastWithBlack = (luminance + 0.05) / 0.05
  return contrastWithWhite >= contrastWithBlack ? "#ffffff" : "#0a0a0a"
}

/**
 * CSS custom properties to apply on `<html>` for the configured brand color.
 * Overrides both the primary and sidebar-primary pairs so the accent stays
 * legible in light and dark themes alike.
 */
export function brandingCssVars(primaryColor: string | null): Record<string, string> | undefined {
  const color = primaryColor && normalizeHexColor(primaryColor)
  if (!color) return undefined

  const foreground = readableForeground(color)
  return {
    "--primary": color,
    "--primary-foreground": foreground,
    "--sidebar-primary": color,
    "--sidebar-primary-foreground": foreground,
  }
}
