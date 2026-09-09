"use client"

import * as React from "react"
import { Radar, ServerCog, Trash2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SubHeader } from "@/components/layout/page-header"
import { extractErrorMessage } from "@/lib/api-error"
import type { HarborOrphan, RegistryOrphans } from "@/lib/registries/orphans"

/**
 * The Harbor counterpart of an orphaned Kubernetes Job.
 *
 * The feed above already names a Job running under the Gateway's label with no row behind it.
 * The same thing happens on the Harbor side and is worse, because a leftover replication
 * policy is not a one-off that a TTL will collect — it is armed and fires on a schedule
 * forever. Nothing else in the app would ever surface it.
 *
 * Behind a button rather than run on page load: it costs two API calls per Harbor, and the
 * answer is only interesting when somebody is asking.
 */
export function OrphanScanner() {
  const t = useTranslations("activity.orphans")
  const tc = useTranslations("common")
  const tr = useTranslations("replication")
  const [pendingCleanup, setPendingCleanup] = React.useState<Array<{ id: string; lastError: string | null }>>([])
  const [scanning, setScanning] = React.useState(false)
  const [busyRegistry, setBusyRegistry] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<RegistryOrphans[] | null>(null)

  async function scan() {
    setScanning(true)
    try {
      const res = await fetch("/api/registries/orphans")
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("scanFailed")))
        return
      }
      setResult((body as { registries: RegistryOrphans[] }).registries)
      setPendingCleanup(body.pendingReplicationCleanup ?? [])
    } catch {
      toast.error(t("scanFailed"))
    } finally {
      setScanning(false)
    }
  }

  async function cleanup(registry: RegistryOrphans) {
    setBusyRegistry(registry.registryId)
    try {
      const res = await fetch("/api/registries/orphans", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryId: registry.registryId, orphans: registry.orphans }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("cleanupFailed")))
        return
      }

      const summary = body as { deleted: number; failures: Array<{ name: string; error: string }> }
      if (summary.failures.length > 0) {
        toast.warning(
          t("cleanedPartial", {
            deleted: summary.deleted,
            failed: summary.failures.length,
            error: summary.failures[0].error,
          }),
        )
      } else {
        toast.success(t("cleaned", { count: summary.deleted, registry: registry.registryName }))
      }
      // Re-scanned rather than patched in place: the only honest way to say what is left is to
      // ask the Harbor again.
      await scan()
    } catch {
      toast.error(t("cleanupFailed"))
    } finally {
      setBusyRegistry(null)
    }
  }

  const withOrphans = result?.filter((registry) => registry.orphans.length > 0) ?? []
  const unreadable = result?.filter((registry) => registry.error) ?? []
  const total = withOrphans.reduce((sum, registry) => sum + registry.orphans.length, 0)

  return (
    <section className="flex flex-col gap-3 px-4 lg:px-6">
      <SubHeader
        title={t("title")}
        description={t("description")}
        action={
          <Button variant="outline" size="sm" onClick={scan} disabled={scanning}>
            <Radar className={scanning ? "animate-spin" : undefined} />
            {scanning ? t("scanning") : result ? t("rescan") : t("scan")}
          </Button>
        }
      />

      {pendingCleanup.length > 0 && <div className="rounded-md border border-warning/30 px-3 py-2 text-xs">
        <p>{tr("cleanupPending", { count: pendingCleanup.length })}</p>
        {pendingCleanup.map((row) => <p key={row.id} className="mt-1 text-muted-foreground">{row.lastError}</p>)}
      </div>}
      {result && (
        <div className="flex flex-col gap-3">
          {unreadable.map((registry) => (
            <p
              key={registry.registryId}
              role="status"
              className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 break-words">
                {t("unreadable", { registry: registry.registryName, error: registry.error ?? "" })}
              </span>
            </p>
          ))}

          {total === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              {(unreadable.length > 0 || pendingCleanup.length > 0) ? t("cleanButPartial") : t("clean")}
            </p>
          ) : (
            withOrphans.map((registry) => (
              <article key={registry.registryId} className="flex flex-col gap-3 rounded-lg border px-4 py-3.5">
                <div className="flex flex-col gap-2 @xl/main:flex-row @xl/main:items-center @xl/main:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <ServerCog className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate text-sm font-medium">{registry.registryName}</span>
                    <Badge variant="destructive">
                      {t("count", { count: registry.orphans.length })}
                    </Badge>
                  </div>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="self-end text-destructive hover:text-destructive @xl/main:self-auto"
                        disabled={busyRegistry === registry.registryId}
                      >
                        <Trash2 />
                        {t("cleanup")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("confirmTitle", { registry: registry.registryName })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("confirmDescription", { count: registry.orphans.length })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <ul className="max-h-56 overflow-auto rounded-md border bg-muted/25 p-2">
                        {registry.orphans.map((orphan) => (
                          <li key={orphan.name} className="truncate py-0.5 font-mono text-xs">
                            {orphan.name}
                          </li>
                        ))}
                      </ul>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                        <Button variant="destructive" onClick={() => cleanup(registry)}>
                          {t("cleanup")}
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                <ul className="flex flex-col divide-y">
                  {registry.orphans.map((orphan) => (
                    <li key={orphan.name} className="flex flex-wrap items-center gap-2 py-1.5 first:pt-0 last:pb-0">
                      <KindBadge kind={orphan.kind} />
                      <code className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {orphan.name}
                      </code>
                      {orphan.enabled && (
                        <span className="text-xs text-warning">{t("stillArmed")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            ))
          )}
        </div>
      )}
    </section>
  )
}

function KindBadge({ kind }: { kind: HarborOrphan["kind"] }) {
  const t = useTranslations("activity.orphans")
  const key =
    kind === "meshPolicy"
      ? "kindMeshPolicy"
      : kind === "meshEndpoint"
        ? "kindMeshEndpoint"
        : kind === "mirrorPolicy"
          ? "kindMirrorPolicy"
          : "kindMirrorEndpoint"
  return (
    <Badge variant="outline" className="font-normal">
      {t(key)}
    </Badge>
  )
}
