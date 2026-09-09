import type { CSSProperties } from "react"
import type { Metadata } from "next"
import { getTranslations } from "next-intl/server"
import { Boxes, ContainerIcon, ShieldCheck } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LoginForm } from "@/components/auth/login-form"
import { BrandMark } from "@/components/layout/brand-mark"
import { LocaleSwitcherButton } from "@/components/layout/locale-switcher"
import { getConfig } from "@/lib/config"
import { brandTitle } from "@/lib/settings/branding"
import type { LoginFeature } from "@/lib/settings/login-content"
import { getInstanceSettings, getLoginContent } from "@/lib/settings/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("login")
  return { title: t("title") }
}

const DEFAULT_FEATURE_KEYS = ["clusters", "mirroring", "robots"] as const

// Icons stay ours: an operator writes the copy, not the artwork. Custom bullets reuse
// the same three glyphs in order, and a fourth falls back to the first.
const FEATURE_ICONS = [Boxes, ContainerIcon, ShieldCheck] as const

export default async function LoginPage() {
  // Read on the server and passed down as props: the sign-in options vary per installation,
  // and a NEXT_PUBLIC_* would bake them into the image at build time (CLAUDE.md §0.2).
  const config = getConfig()
  const [branding, content, t] = await Promise.all([
    getInstanceSettings(),
    getLoginContent(),
    getTranslations("login"),
  ])
  const title = brandTitle(branding)

  // Null on any field means the operator never overrode it — fall back to the
  // translated copy, which follows the visitor's locale.
  const heroTitle = content.heroTitle ?? t("hero.title")
  const heroSubtitle = content.heroSubtitle ?? t("hero.subtitle")
  const footnote = content.footnote ?? t("hero.footnote")
  const description = content.description ?? t("description")
  const features: LoginFeature[] =
    content.features ??
    DEFAULT_FEATURE_KEYS.map((key) => ({
      title: t(`hero.features.${key}.title`),
      description: t(`hero.features.${key}.description`),
    }))

  return (
    <div className="relative grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Showcase panel — desktop only. Everything in it is decoration plus a short value
          statement, so a narrow viewport drops it entirely rather than stacking it above
          the form and pushing the fields below the fold. */}
      <aside className="relative hidden overflow-hidden border-r bg-muted/30 lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_85%_at_10%_0%,--theme(--color-primary/16%),transparent_60%),radial-gradient(90%_70%_at_95%_100%,--theme(--color-primary/12%),transparent_55%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,--theme(--color-foreground/6%)_1px,transparent_1px),linear-gradient(to_bottom,--theme(--color-foreground/6%)_1px,transparent_1px)] bg-[size:46px_46px] [mask-image:radial-gradient(75%_65%_at_35%_35%,black,transparent)]"
        />

        <div className="animate-enter relative flex items-center gap-3">
          <BrandMark
            brandName={branding.brandName}
            logoUrl={branding.logoUrl}
            className="size-9"
            iconClassName="size-8"
          />
          <span className="text-sm font-semibold tracking-tight">{title}</span>
        </div>

        <div className="relative max-w-lg">
          <h2
            className="animate-enter text-4xl font-semibold tracking-tight text-balance xl:text-5xl"
            style={{ "--enter-delay": "80ms" } as CSSProperties}
          >
            {heroTitle}
          </h2>
          <p
            className="animate-enter mt-5 text-base text-pretty text-muted-foreground"
            style={{ "--enter-delay": "140ms" } as CSSProperties}
          >
            {heroSubtitle}
          </p>

          {features.length > 0 && (
            <ul className="mt-12 flex flex-col gap-6">
              {features.map((feature, index) => {
                const Icon = FEATURE_ICONS[index % FEATURE_ICONS.length]
                return (
                  <li
                    key={`${feature.title}-${index}`}
                    className="animate-enter flex gap-4"
                    style={{ "--enter-delay": `${200 + index * 70}ms` } as CSSProperties}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/8 text-primary shadow-[var(--elevation-sm)]">
                      <Icon className="size-4.5" aria-hidden="true" />
                    </span>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{feature.title}</p>
                      {feature.description && (
                        <p className="text-sm text-pretty text-muted-foreground">
                          {feature.description}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <p
          className="animate-enter relative text-xs text-muted-foreground"
          style={{ "--enter-delay": "420ms" } as CSSProperties}
        >
          {footnote}
        </p>
      </aside>

      <main className="relative flex items-center justify-center overflow-hidden bg-background p-6 sm:p-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_-10%,--theme(--color-primary/10%),transparent)]"
        />
        <Card
          className="animate-enter relative w-full max-w-sm gap-7 py-8 shadow-[var(--elevation-lg)]"
          style={{ "--enter-delay": "60ms" } as CSSProperties}
        >
          <CardHeader className="items-center text-center">
            <BrandMark
              brandName={branding.brandName}
              logoUrl={branding.logoUrl}
              className="mx-auto mb-3 size-14 rounded-2xl border bg-muted/40 p-2.5 shadow-[var(--elevation-sm)]"
              iconClassName="size-full"
            />
            <CardTitle>
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            </CardTitle>
            <CardDescription className="text-pretty">{description}</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm
              oidcEnabled={config.oidcEnabled}
              oidcDisplayName={config.oidcDisplayName}
              localLoginEnabled={config.oidcAllowLocalLogin}
            />
          </CardContent>
        </Card>
      </main>

      <LocaleSwitcherButton className="absolute top-4 right-4 z-10" />
    </div>
  )
}
