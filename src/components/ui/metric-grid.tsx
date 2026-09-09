import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type MetricTone = "default" | "success" | "warning" | "destructive"

export interface Metric {
  label: string
  value: string | number
  icon?: LucideIcon
  /** Colors the value. Use it only when the number is a signal, not for decoration. */
  tone?: MetricTone
}

const TONE_CLASS: Record<MetricTone, string> = {
  default: "",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
}

/**
 * The one way this app shows a row of headline numbers: a hairline-divided grid of cells,
 * two per row on phones and all in one row from `sm`. Every overview page uses it so the
 * eye lands on the same shape regardless of section.
 */
export function MetricGrid({ metrics, className }: { metrics: Metric[]; className?: string }) {
  const columns = metrics.length
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border",
        columns === 1 && "grid-cols-1",
        columns === 3 && "sm:grid-cols-3",
        columns >= 4 && "sm:grid-cols-4",
        className,
      )}
    >
      {metrics.map(({ icon: Icon, label, value, tone = "default" }) => (
        <div
          key={label}
          className="flex min-w-0 items-start justify-between gap-3 bg-card px-4 py-4 sm:px-5 sm:py-5"
        >
          <div className="min-w-0">
            <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
            <dd className={cn("mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl", TONE_CLASS[tone])}>
              {value}
            </dd>
          </div>
          {Icon && (
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground", TONE_CLASS[tone])}>
              <Icon className="size-4" aria-hidden="true" />
            </span>
          )}
        </div>
      ))}
    </dl>
  )
}
