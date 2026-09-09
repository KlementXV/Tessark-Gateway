"use client"

import Link from "next/link"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("errors")
  const tc = useTranslations("common")
  return (
    <div className="flex min-h-[70dvh] items-center justify-center px-4 py-16">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("appTitle")}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t("appDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={reset}>
            <RefreshCw />
            {tc("tryAgain")}
          </Button>
          <Button variant="outline" asChild>
            <Link href="/projects">{t("backToProjects")}</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
