import type { ReactNode } from "react"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { LinkPending } from "@/components/layout/link-pending"

/**
 * Every dashboard page opens with this: optional back link, title row (with badges for
 * entity pages), a one-line description, an action slot that stacks under the title on
 * phones, and optional meta / metrics blocks below.
 *
 * `size="lg"` is for entity pages where the title *is* the resource name.
 */
export function PageHeader({
  title,
  description,
  badges,
  meta,
  action,
  back,
  size = "md",
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  /** Status chips rendered inline after the title. */
  badges?: ReactNode
  /** Small secondary facts (cluster, URL…) under the description. */
  meta?: ReactNode
  action?: ReactNode
  back?: { href: string; label: string }
  size?: "md" | "lg"
  /** Anything that belongs to the header block, typically a <MetricGrid />. */
  children?: ReactNode
  className?: string
}) {
  return (
    <header className={cn("animate-enter flex flex-col gap-5 px-4 lg:px-6", className)}>
      {back && (
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground">
          <Link href={back.href}>
            <ChevronLeft />
            {back.label}
            <LinkPending />
          </Link>
        </Button>
      )}

      <div className="flex flex-col gap-4 @3xl/main:flex-row @3xl/main:items-end @3xl/main:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1
              className={cn(
                "min-w-0 font-semibold text-balance break-words",
                size === "lg" ? "text-2xl tracking-[-0.035em] sm:text-3xl" : "text-2xl tracking-[-0.03em]",
              )}
            >
              {title}
            </h1>
            {badges}
          </div>
          {description && (
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
          )}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {action && (
          <div className="w-full shrink-0 sm:w-auto [&_[data-slot=button]]:w-full sm:[&_[data-slot=button]]:w-auto">
            {action}
          </div>
        )}
      </div>

      {children}
    </header>
  )
}

/** A dot separator for the `meta` row. */
export function MetaDot() {
  return <span className="size-0.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
}

/**
 * The heading of a section *inside* a page — a page that answers one question in two halves
 * (Policy: where images may come from, and which routes are open) rather than two pages the
 * operator has to hold together in their head.
 *
 * Deliberately not a second <PageHeader>: it renders an h2, carries no metrics slot, and its
 * action sits on the same line, so a section never competes with the page's own title.
 */
export function SubHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-[-0.02em]">{title}</h2>
        {description && (
          <p className="mt-0.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {action && (
        <div className="w-full shrink-0 sm:w-auto [&_[data-slot=button]]:w-full sm:[&_[data-slot=button]]:w-auto">
          {action}
        </div>
      )}
    </div>
  )
}
