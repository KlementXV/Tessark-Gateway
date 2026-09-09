import Link from "next/link"
import { Compass } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { Button } from "@/components/ui/button"

export default async function DashboardNotFound() {
  const t = await getTranslations("errors")
  return (
    <div className="flex min-h-[65dvh] flex-col items-center justify-center gap-5 px-4 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Compass className="size-5" aria-hidden="true" />
      </span>
      <div>
        <p className="font-mono text-xs text-muted-foreground">404</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{t("notFoundTitle")}</h1>
        <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
          {t("notFoundDashboard")}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild>
          <Link href="/projects">{t("viewProjects")}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/registries">{t("viewRegistries")}</Link>
        </Button>
      </div>
    </div>
  )
}
