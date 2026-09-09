import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"

import { LoginContentForm, type LoginContentDefaults } from "@/components/settings/login-content-form"
import { brandTitle } from "@/lib/settings/branding"
import { BrandingForm } from "@/components/settings/branding-form"
import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { settingsTabsFor } from "@/components/settings/settings-tabs"
import { auth } from "@/auth"
import { getConfig } from "@/lib/config"
import { Role } from "@/generated/prisma/client"
import { getInstanceSettings, getLoginContent } from "@/lib/settings/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("branding") }
}

export default async function BrandingSettingsPage() {
  const session = await auth()
  if (session?.user?.role !== Role.SUPERADMIN) redirect("/settings")

  const [branding, content, t, tNav, tLoginPage, tLogin] = await Promise.all([
    getInstanceSettings(),
    getLoginContent(),
    getTranslations("settings.brandingPage"),
    getTranslations("nav"),
    getTranslations("settings.loginPagePage"),
    getTranslations("login"),
  ])

  const defaults: LoginContentDefaults = {
    description: tLogin("description"),
    heroTitle: tLogin("hero.title"),
    heroSubtitle: tLogin("hero.subtitle"),
    footnote: tLogin("hero.footnote"),
    features: (["clusters", "mirroring", "robots"] as const).map((key) => ({
      title: tLogin(`hero.features.${key}.title`),
      description: tLogin(`hero.features.${key}.description`),
    })),
  }

  return (
    <>
      <SectionTabs tabs={settingsTabsFor(session.user.role)} label={tNav("settings")} />
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <div className="flex flex-col gap-10 px-4 lg:px-6">
        <BrandingForm branding={branding} maxLogoBytes={getConfig().logoMaxBytes} />
        <section id="login" aria-labelledby="login-heading" className="flex scroll-mt-6 flex-col gap-5">
          <header>
            <h2 id="login-heading" className="text-lg font-semibold tracking-tight">{tLoginPage("title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{tLoginPage("description")}</p>
          </header>
          <LoginContentForm content={content} defaults={defaults} brandTitle={brandTitle(branding)} />
        </section>
      </div>
    </>
  )
}
