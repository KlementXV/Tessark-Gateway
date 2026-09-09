"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { isSafeLogoUrl } from "@/lib/settings/branding"

/**
 * The brand mark used in the sidebar header, login card and branding preview.
 * It falls back to the theme-aware Ocify artwork when an operator-supplied logo
 * is missing or fails to load, so a stale URL never leaves a broken-image glyph.
 */
export function BrandMark({
  brandName,
  logoUrl,
  className,
  iconClassName,
}: {
  brandName: string
  logoUrl: string | null
  className?: string
  iconClassName?: string
}) {
  const t = useTranslations("nav")
  // Track *which* URL failed rather than a boolean, so a new URL gets a fresh
  // attempt without an effect resetting the flag.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null)

  // Saved values are validated server-side, but the branding form previews raw
  // keystrokes — re-check here so a half-typed `javascript:` never reaches `src`.
  const showLogo = logoUrl !== null && logoUrl !== failedUrl && isSafeLogoUrl(logoUrl)

  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center overflow-hidden",
        className,
      )}
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary client-supplied URL, not worth a remotePatterns allowlist
        <img
          src={logoUrl}
          alt={brandName}
          className="size-full object-contain"
          decoding="async"
          onError={() => setFailedUrl(logoUrl)}
        />
      ) : (
        <span
          role="img"
          aria-label={t("brandLogo", { brandName })}
          className={cn("flex size-full items-center justify-center", iconClassName)}
        >
          {/* The two artwork files are intentionally swapped with CSS so the mark
              follows the app theme, including a manually selected theme. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- local SVG artwork */}
          <img
            src="/ocify_black.svg"
            alt=""
            aria-hidden="true"
            className="h-full w-auto object-contain dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- local SVG artwork */}
          <img
            src="/ocify_white.svg"
            alt=""
            aria-hidden="true"
            className="hidden h-full w-auto object-contain dark:block"
          />
        </span>
      )}
    </div>
  )
}
