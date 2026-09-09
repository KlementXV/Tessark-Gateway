import Link from "next/link"
import { Compass } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { Button } from "@/components/ui/button"

export default async function NotFound() {
  const t = await getTranslations("errors")
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-4 text-center">
      <div className="animate-enter flex flex-col items-center gap-4">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Compass className="size-6 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-mono text-sm text-muted-foreground">404</p>
          <h1 className="text-xl font-semibold tracking-tight">{t("notFoundTitle")}</h1>
          <p className="max-w-sm text-sm text-muted-foreground text-balance">
            {t("notFoundRoot")}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/projects">{t("backToProjects")}</Link>
        </Button>
      </div>
    </div>
  )
}
