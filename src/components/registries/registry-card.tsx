import Link from "next/link"
import { ArrowUpRight, Clock3, Lock, Send, Server, Unlock } from "lucide-react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HarborVersionBadge, HealthBadge } from "@/components/registries/registry-status-badge"
import type { RegistryHealth } from "@/lib/registries/health"

export interface RegistryCardData {
  id: string
  name: string
  baseUrl: string
  authType: string
  role?: "MANAGED" | "DELIVERY"
  description: string | null
  health: RegistryHealth
  pendingOperations?: number
  weakPassword?: boolean
  /** Last version *observed* on this Harbor — shown when the live probe cannot answer. */
  harborVersion?: string | null
}

// The whole card is clickable through a stretched link on the title rather than a wrapping
// <a>, so cluster actions (removing a member) can sit inside it without nesting a button in
// an anchor.
export function RegistryCard({
  registry,
  action,
  returnTo,
}: {
  registry: RegistryCardData
  action?: React.ReactNode
  returnTo?: string
}) {
  const t = useTranslations("registries.card")
  const security = useTranslations("registrySecurity")
  return (
    <Card className="group relative h-full gap-0 overflow-hidden rounded-lg py-0 shadow-none transition-[transform,background-color,border-color,box-shadow] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-muted/10 hover:shadow-sm active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <CardHeader className="px-4 pt-4 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/60 text-muted-foreground transition-colors duration-200 group-hover:text-foreground">
            <Server className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <CardTitle className="min-w-0 truncate text-sm">
                <Link
                  href={
                    returnTo
                      ? `/registries/${registry.id}?from=${encodeURIComponent(returnTo)}`
                      : `/registries/${registry.id}`
                  }
                  aria-label={t("open", { name: registry.name })}
                  className="outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
                >
                  {registry.name}
                </Link>
              </CardTitle>
              <ArrowUpRight className="size-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-[transform,opacity] duration-200 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:translate-x-0" />
            </div>
          </div>
          <div className="relative z-10 flex shrink-0 items-center gap-1">
            <HealthBadge health={registry.health} />
            {action}
          </div>
        </div>
        <p className="truncate pl-12 font-mono text-xs text-muted-foreground" title={registry.baseUrl}>
          {registry.baseUrl}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-0">
        {registry.weakPassword && <p className="px-4 pb-3 text-sm font-medium text-warning">{security("weak")}</p>}
        {registry.description && (
          <p className="line-clamp-2 px-4 pb-4 text-sm leading-relaxed text-muted-foreground">
            {registry.description}
          </p>
        )}
        <div className="mt-auto flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/25 px-4 py-2.5">
          <HarborVersionBadge version={registry.health.version} />
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {registry.authType === "none" ? (
              <>
                <Unlock className="size-3" /> {t("noAuth")}
              </>
            ) : (
              <>
                <Lock className="size-3" /> {registry.authType}
              </>
            )}
          </span>
          {registry.role === "DELIVERY" && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Send className="size-3" aria-hidden="true" /> {t("roleDelivery")}
            </span>
          )}
          {Boolean(registry.pendingOperations) && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
              <Clock3 className="size-3" aria-hidden="true" />
              {t("queued", { count: registry.pendingOperations ?? 0 })}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
