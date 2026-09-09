import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { HistoryForm } from "@/components/settings/history-form"
import { settingsTabsFor } from "@/components/settings/settings-tabs"
import { Role } from "@/generated/prisma/client"
import { getHistoryRetentionDays } from "@/lib/history/retention"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("history") }
}

// SUPERADMIN like the rest of InstanceSettings: this decides what disappears for every user of
// the instance, and a purge cannot be undone.
export default async function HistorySettingsPage() {
  const session = await auth()
  if (session?.user?.role !== Role.SUPERADMIN) redirect("/settings")

  const [retentionDays, t, tNav] = await Promise.all([
    getHistoryRetentionDays(),
    getTranslations("settings.history"),
    getTranslations("nav"),
  ])

  return (
    <>
      <SectionTabs tabs={settingsTabsFor(session.user.role)} label={tNav("settings")} />
      <PageHeader title={t("title")} description={t("description")} />
      <div className="px-4 lg:px-6">
        <HistoryForm retentionDays={retentionDays} />
      </div>
    </>
  )
}
