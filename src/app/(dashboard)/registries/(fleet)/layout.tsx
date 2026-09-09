import { getTranslations } from "next-intl/server"

import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"
import { SectionTabs } from "@/components/layout/section-tabs"
import { REGISTRY_TABS } from "@/components/registries/registry-tabs"

// The tab row for the four fleet-wide pages, rendered once here rather than repeated at the
// top of each of them. Entity pages (/registries/[id], /registries/clusters/[id]) sit outside
// this group on purpose: they are drill-ins reached from a tab, not tabs themselves, and
// showing the row again there would suggest they are.
export default async function FleetLayout({ children }: { children: React.ReactNode }) {
  const tNav = await getTranslations("nav")
  const showBuilds = getConfig().buildsBetaEnabled || await prisma.scheduledBuild.count() > 0
  return (
    <>
      <SectionTabs tabs={REGISTRY_TABS.filter((tab) => tab.labelKey !== "builds" || showBuilds)} label={tNav("registries")} />
      {children}
    </>
  )
}
