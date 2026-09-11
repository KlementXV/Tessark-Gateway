import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Fingerprint } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { PasswordForm } from "@/components/settings/password-form"
import { ProfileForm } from "@/components/settings/profile-form"
import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { settingsTabsFor } from "@/components/settings/settings-tabs"
import { getConfig } from "@/lib/config"
import { getUserProfile } from "@/lib/users/profile"
import { APP_VERSION } from "@/lib/version"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("settings") }
}

export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  // Read-through to the database rather than the session: the JWT was minted at login and
  // would still show the previous name/email right after the user edits them here.
  const [profile, t, tNav, tRoles] = await Promise.all([
    getUserProfile(session.user.id),
    getTranslations("settings.profile"),
    getTranslations("nav"),
    getTranslations("settings.roles"),
  ])
  if (!profile) redirect("/login")

  const role = tRoles(profile.role)

  return (
    <>
      <SectionTabs tabs={settingsTabsFor(profile.role)} label={tNav("settings")} />
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      <div className="animate-enter grid items-start gap-6 px-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.75fr)] lg:px-6">
        <div className="flex min-w-0 flex-col gap-6">
          <ProfileForm profile={profile} maxAvatarBytes={getConfig().avatarMaxBytes} />
          {/* Only local accounts have a password stored here to rotate. */}
          {profile.credentialsEditable && <PasswordForm />}
        </div>

        <div>
          <section className="overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)]">
            <header className="flex items-start gap-3 px-5 py-5 sm:px-6">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                <Fingerprint className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{t("access")}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("accessHint")}</p>
              </div>
            </header>

            <div className="border-t px-5 py-5 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">{t("accessLevel")}</span>
                <span className="rounded-md border bg-background px-2 py-1 text-xs font-semibold tracking-wide uppercase">
                  {role}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">{t("authentication")}</span>
                <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {profile.credentialsEditable
                    ? t("localCredentials")
                    : (profile.providerLabel ?? profile.authProvider)}
                </code>
              </div>
            </div>
          </section>
        </div>
      </div>
      <p className="px-4 pt-6 text-xs text-muted-foreground lg:px-6">Tessark Gateway · v{APP_VERSION}</p>
    </>
  )
}
