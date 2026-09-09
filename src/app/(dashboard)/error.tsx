"use client"

import { AlertTriangle, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("errors")
  const tc = useTranslations("common")
  return (
    <section className="mx-4 flex min-h-[55dvh] items-center justify-center rounded-xl border border-dashed px-6 py-16 lg:mx-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-lg font-semibold">{t("dashboardTitle")}</h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            {t("dashboardDescription")}
          </p>
        </div>
        <Button type="button" onClick={reset}>
          <RefreshCw />
          {tc("tryAgain")}
        </Button>
      </div>
    </section>
  )
}
