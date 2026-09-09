import type { CSSProperties } from "react"
import { CloudDownload, Pencil } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { SubHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DeleteSourceButton } from "@/components/sources/delete-source-button"
import { SourceFormDialog } from "@/components/sources/source-form-dialog"
import { listSources } from "@/lib/sources/service"

// Where images may be mirrored *from*. One half of the Policy page: this section says what
// may be reached at all, the rules section next to it says which routes are open. An admin
// setting up the gateway is deciding both halves of the same question.
export async function SourcesSection() {
  const [sources, t] = await Promise.all([listSources(), getTranslations("sources")])
  const hosts = sources.map((s) => s.host)

  return (
    <section
      className="animate-enter flex flex-col gap-4 px-4 lg:px-6"
      style={{ "--enter-delay": "60ms" } as CSSProperties}
    >
      <SubHeader
        title={t("title")}
        description={t("description")}
        action={<SourceFormDialog existingHosts={hosts} />}
      />
      {sources.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <CloudDownload className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
          <SourceFormDialog existingHosts={hosts} />
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {sources.map((source) => (
            <div key={source.id} className="flex flex-col items-stretch gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{source.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {source.host}
                  </code>
                  {!source.enabled && <Badge variant="outline">{t("off")}</Badge>}
                  {source.authType !== "none" && (
                    <Badge variant="outline" className="font-normal">
                      {source.authType === "basic" ? t("basicAuth") : t("token")}
                    </Badge>
                  )}
                </div>
                <span
                  className="line-clamp-2 break-all font-mono text-xs leading-5 text-muted-foreground sm:truncate"
                  title={source.allowedRepos.length > 0 ? source.allowedRepos.join(" · ") : undefined}
                >
                  {source.allowedRepos.length > 0
                    ? source.allowedRepos.join("  ·  ")
                    : t("noRepos")}
                </span>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1">
                <SourceFormDialog
                  source={source}
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      aria-label={t("editAria", { name: source.name })}
                    >
                      <Pencil />
                    </Button>
                  }
                />
                <DeleteSourceButton id={source.id} name={source.name} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
