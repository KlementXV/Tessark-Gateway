import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { isUsable, type RegistryHealth } from "@/lib/registries/health"

function StatusDot({ className, pulse }: { className?: string; pulse?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center">
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex size-2 rounded-full animate-status-pulse",
            className
          )}
        />
      )}
      <span className={cn("relative inline-flex size-1.5 rounded-full", className)} />
    </span>
  )
}

// Three distinct failure modes, three distinct labels — "Unreachable" on a bad URL calls
// for a very different fix than "Auth failed" on a Harbor that is otherwise up.
export function HealthBadge({ health }: { health: RegistryHealth }) {
  const t = useTranslations("registries.health")
  if (isUsable(health)) {
    return (
      <Badge variant="outline" className="gap-1.5 border-success/40 text-success">
        <StatusDot className="bg-success" pulse />
        {t("healthy")}
      </Badge>
    )
  }

  if (!health.reachable) {
    return (
      <Badge variant="outline" className="gap-1.5 border-destructive/40 text-destructive">
        <StatusDot className="bg-destructive" />
        {t("unreachable")}
      </Badge>
    )
  }

  if (!health.harbor) {
    return (
      <Badge variant="outline" className="gap-1.5 border-destructive/40 text-destructive">
        <StatusDot className="bg-destructive" />
        {t("notHarbor")}
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="gap-1.5 border-warning/40 text-warning">
      <StatusDot className="bg-warning" />
      {t("authFailed")}
    </Badge>
  )
}

export function HarborVersionBadge({ version }: { version: string | null }) {
  return <Badge variant="secondary">{version ? `Harbor ${version}` : "Harbor"}</Badge>
}
