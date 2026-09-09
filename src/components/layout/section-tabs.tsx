"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { LinkPending } from "@/components/layout/link-pending"

export interface SectionTab {
  href: string
  /** Key under the `nav` namespace — tabs are declared in server-agnostic constants. */
  labelKey: SectionTabKey
}

export type SectionTabKey =
  | "projects"
  | "myRequests"
  | "harborFleet"
  | "mirrors"
  | "builds"
  | "activity"
  | "policy"
  | "pending"
  | "history"
  | "profile"
  | "apiTokens"
  | "users"
  | "branding"
  | "loginPage"

/**
 * Sub-navigation inside one sidebar section (Projects › My requests, Registries › Upstream
 * sources, Settings › Users…). One sidebar entry, one row of tabs: the same pattern in every
 * section, so the sidebar never repeats what the tabs already say.
 */
export function SectionTabs({ tabs, label }: { tabs: SectionTab[]; label: string }) {
  const t = useTranslations("nav")
  const pathname = usePathname()

  return (
    // The hairline is an inset shadow on the scrolling row rather than a border on the nav:
    // the active tab's 2px underline then sits *on* the line without overflowing the box by a
    // pixel, which is exactly what made Safari show a scrollbar here.
    <nav className="scrollbar-none max-w-full overflow-x-auto px-4 lg:px-6" aria-label={label}>
      <div className="flex w-max min-w-full items-center gap-1 shadow-[inset_0_-1px_0_0_var(--color-border)]">
        {tabs.map((tab) => {
          const active = pathname === tab.href
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {t(tab.labelKey)}
              <LinkPending className="-mr-1 size-3" />
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
