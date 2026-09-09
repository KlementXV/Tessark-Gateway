import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { BookOpen, KeyRound } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { ApiTokensTable } from "@/components/settings/api-tokens-table"
import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { settingsTabsFor } from "@/components/settings/settings-tabs"
import { auth } from "@/auth"
import { toPublicApiToken } from "@/lib/api-tokens/public"
import { listTokensForUser } from "@/lib/api-tokens/service"
import { getConfig } from "@/lib/config"
import { Role } from "@/generated/prisma/client"
import { Button } from "@/components/ui/button"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("apiTokens") }
}

export default async function ApiTokensSettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const [rawTokens, t, tNav] = await Promise.all([
    listTokensForUser(session.user.id),
    getTranslations("settings.tokensPage"),
    getTranslations("nav"),
  ])
  const tokens = rawTokens.map(toPublicApiToken)

  return (
    <>
      <SectionTabs tabs={settingsTabsFor(session.user.role ?? Role.USER)} label={tNav("settings")} />
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          <Button variant="outline" asChild>
            <Link href="/api/docs">
              <BookOpen />
              {t("docs")}
            </Link>
          </Button>
        }
      />

      <section className="animate-enter mx-4 overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)] lg:mx-6">
        <header className="border-b px-6 py-6 sm:px-8">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              <KeyRound className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">{t("yourTokens")}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("summary", { active: tokens.filter((token) => !token.revokedAt).length, total: tokens.length })}
              </p>
            </div>
          </div>
        </header>

        <ApiTokensTable
          tokens={tokens.map((token) => ({
            ...token,
            expiresAt: token.expiresAt?.toISOString() ?? null,
            lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
            revokedAt: token.revokedAt?.toISOString() ?? null,
            createdAt: token.createdAt.toISOString(),
          }))}
          maxTtlDays={getConfig().apiTokenMaxTtlDays}
        />
      </section>
    </>
  )
}
