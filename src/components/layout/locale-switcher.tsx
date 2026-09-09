"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { Check, Languages } from "lucide-react"

import { setLocaleAction } from "@/i18n/actions"
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from "@/i18n/locale"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

function useLocaleSwitch() {
  const router = useRouter()
  const locale = useLocale()
  const [pending, startTransition] = React.useTransition()

  function change(next: Locale) {
    if (next === locale) return
    startTransition(async () => {
      await setLocaleAction(next)
      // The cookie is set; every Server Component re-renders in the new language, and the
      // client provider picks the new messages up from the refreshed RSC payload.
      router.refresh()
    })
  }

  return { locale, pending, change }
}

function LocaleItems({ locale, onSelect }: { locale: Locale; onSelect: (locale: Locale) => void }) {
  return (
    <>
      {SUPPORTED_LOCALES.map((candidate) => (
        <DropdownMenuItem key={candidate} onSelect={() => onSelect(candidate)} lang={candidate}>
          <span className="flex-1">{LOCALE_LABELS[candidate]}</span>
          {candidate === locale && <Check className="size-4" aria-hidden="true" />}
        </DropdownMenuItem>
      ))}
    </>
  )
}

/**
 * Language picker as a nested menu, rendered inside another dropdown (the profile menu in
 * the sidebar footer) rather than as a rail entry of its own.
 */
export function LocaleMenuSub() {
  const t = useTranslations("locale")
  const { locale, pending, change } = useLocaleSwitch()

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={pending} aria-label={t("switch")}>
        <Languages />
        <span className="flex-1">{t("label")}</span>
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {locale}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="min-w-40">
          <LocaleItems locale={locale} onSelect={change} />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

/** Compact standalone button, for the login screen and anywhere outside the sidebar. */
export function LocaleSwitcherButton({ className }: { className?: string }) {
  const t = useTranslations("locale")
  const { locale, pending, change } = useLocaleSwitch()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-label={t("switch")}
          className={cn("gap-2 text-muted-foreground", className)}
        >
          <Languages />
          {LOCALE_LABELS[locale]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <LocaleItems locale={locale} onSelect={change} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
