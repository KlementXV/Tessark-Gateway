import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { UsersRound } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { AddUserDialog } from "@/components/settings/add-user-dialog"
import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { settingsTabsFor } from "@/components/settings/settings-tabs"
import { UsersTable } from "@/components/settings/users-table"
import { auth } from "@/auth"
import { Role } from "@/generated/prisma/client"
import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"
import { toPublicUser } from "@/lib/users/public"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("users") }
}

export default async function UsersSettingsPage() {
  const session = await auth()
  if (session?.user?.role !== Role.SUPERADMIN) redirect("/settings")

  const [rawUsers, t, tNav] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    getTranslations("settings.usersPage"),
    getTranslations("nav"),
  ])
  const config = getConfig()
  const users = rawUsers.map(toPublicUser)
  const enabledCount = users.filter((user) => !user.disabled).length

  return (
    <>
      <SectionTabs tabs={settingsTabsFor(session.user.role)} label={tNav("settings")} />
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={<AddUserDialog />}
      />

      <section className="animate-enter mx-4 overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)] lg:mx-6">
        <header className="border-b px-6 py-6 sm:px-8">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              <UsersRound className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">{t("directory")}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("summary", { active: enabledCount, total: users.length })}
              </p>
            </div>
          </div>
        </header>

        <UsersTable
          users={users}
          currentUserId={session.user.id}
          providerLabel={config.oidcDisplayName}
          providerOwnsRoles={Object.keys(config.oidcRoleMapping).length > 0}
        />
      </section>
    </>
  )
}
