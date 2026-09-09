import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { AlertCircle, Boxes, KeyRound, RefreshCw, ShieldCheck } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { PageBreadcrumb } from "@/components/layout/breadcrumb-context"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { MetricGrid } from "@/components/ui/metric-grid"
import { DeleteRegistryButton } from "@/components/registries/delete-registry-button"
import { EditRegistryDialog } from "@/components/registries/edit-registry-dialog"
import { HarborVersionBadge, HealthBadge } from "@/components/registries/registry-status-badge"
import { SystemRobotCard } from "@/components/registries/system-robot-card"
import { CredentialGuidance } from "@/components/registries/credential-guidance"
import { HarborCompatibilityCard } from "@/components/registries/harbor-compatibility-card"
import { isWeakRegistryPassword } from "@/lib/registries/password-security"
import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth } from "@/lib/registries/check"
import { isUsable } from "@/lib/registries/health"
import { resolveConnection } from "@/lib/registries/resolve"
import { assessHarborVersion } from "@/lib/registries/compatibility"
import { readHarborObservation, recordHarborObservationInBackground } from "@/lib/registries/version-cache"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const [registry, t] = await Promise.all([
    prisma.registry.findUnique({ where: { id }, select: { name: true } }),
    getTranslations("nav"),
  ])
  return { title: registry?.name ?? t("registryDetails") }
}

export default async function RegistryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  // Only the two lists a registry card is reached from, matched exactly: `from` lands in an
  // href, so anything else — an absolute URL, a path with a second segment — is dropped
  // rather than followed.
  const from = typeof query.from === "string" ? query.from : ""
  const fleetReturnTo =
    from === "/registries" ||
    from.startsWith("/registries?") ||
    /^\/registries\/clusters\/[A-Za-z0-9_-]+$/.test(from)
      ? from
      : "/registries"
  const [registry, projectCount, t, tNav] = await Promise.all([
    prisma.registry.findUnique({ where: { id } }),
    prisma.projectPlacement.count({ where: { registryId: id } }),
    getTranslations("registries"),
    getTranslations("nav"),
  ])
  if (!registry) notFound()

  const authLabel: Record<string, string> = {
    none: t("detail.authNone"),
    basic: t("detail.authBasic"),
    token: t("detail.authToken"),
  }

  const systemRobotEnabled = getConfig().systemRobotEnabled

  const conn = resolveConnection(registry)
  const health = await checkRegistryHealth(conn)
  recordHarborObservationInBackground(registry, health)

  const usable = isUsable(health)

  // The live reading wins; the cached one covers the case this page exists to explain — a Harbor
  // that is down right now, whose capabilities the operator still needs to reason about. What is
  // never done is presenting an old reading as current, hence the age travelling with it.
  const observed = readHarborObservation(registry)
  const shownVersion = health.version ?? observed.version
  const compatibility = assessHarborVersion(shownVersion)

  return (
    <>
      <PageBreadcrumb crumbs={[{ label: tNav("registries"), href: fleetReturnTo }, { label: registry.name }]} />

      <PageHeader
        size="lg"
        back={{ href: fleetReturnTo, label: tNav("registries") }}
        title={registry.name}
        badges={
          <>
            <HealthBadge health={health} />
            <HarborVersionBadge version={health.version} />
          </>
        }
        description={registry.description}
        meta={<span className="break-all font-mono">{registry.baseUrl}</span>}
        action={
          <div className="flex w-full shrink-0 gap-2 sm:w-auto [&_[data-slot=button]]:flex-1 sm:[&_[data-slot=button]]:flex-none">
            <EditRegistryDialog
              registry={{
                id: registry.id,
                name: registry.name,
                baseUrl: registry.baseUrl,
                role: registry.role,
                authType: registry.authType as "none" | "basic" | "token",
                username: registry.username,
                insecureTLS: registry.insecureTLS,
                description: registry.description,
              }}
            />
            <DeleteRegistryButton id={registry.id} name={registry.name} returnTo={fleetReturnTo} />
          </div>
        }
      >
        <MetricGrid
          metrics={[
            { icon: Boxes, label: t("detail.metricProjects"), value: projectCount },
            { icon: KeyRound, label: t("detail.metricAuth"), value: authLabel[registry.authType] ?? registry.authType },
            {
              icon: ShieldCheck,
              label: t("detail.metricTls"),
              value: registry.insecureTLS ? t("detail.tlsUnverified") : t("detail.tlsVerified"),
              tone: registry.insecureTLS ? "warning" : "default",
            },
          ]}
        />
      </PageHeader>

      {conn.authType === "basic" && conn.secret && (
        <div className="mx-4 mb-4 lg:mx-6">
          <CredentialGuidance
            weak={isWeakRegistryPassword(conn.secret, conn.username)}
            dedicated={registry.role === "MANAGED"}
          />
        </div>
      )}

      <HarborCompatibilityCard
        assessment={compatibility}
        seenAt={health.version ? new Date() : observed.seenAt}
        fresh={health.version !== null || observed.fresh}
      />

      {systemRobotEnabled && (
        <SystemRobotCard
          registryId={registry.id}
          robotName={registry.systemRobotName}
          syncedAt={registry.systemRobotSyncedAt?.toISOString() ?? null}
        />
      )}

      {!usable && (
        <div
          role="alert"
          className="mx-4 flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:mx-6"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-destructive">{t("detail.unavailableTitle")}</p>
              <p className="mt-0.5 break-words text-sm text-muted-foreground">
                {health.error ?? t("detail.unavailableFallback")}
              </p>
            </div>
          </div>
          <form method="get" className="shrink-0">
            <input type="hidden" name="from" value={fleetReturnTo} />
            <Button type="submit" variant="outline" size="sm" className="w-full sm:w-auto">
              <RefreshCw />
              {t("retry")}
            </Button>
          </form>
        </div>
      )}
    </>
  )
}
