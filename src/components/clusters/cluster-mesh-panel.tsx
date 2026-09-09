"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RefreshCw, ServerOff } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useTranslations } from "next-intl"

import { SubHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { extractErrorMessage } from "@/lib/api-error"
import { formatDateTime } from "@/lib/format-date"
import type { ReplicationClusterView, ReplicationExecutionView } from "@/lib/clusters/replication-view"

// The mesh of one cluster: what the Gateway recorded, and what Harbor did with it. Both
// halves side by side on purpose — a link the Gateway believes is ACTIVE whose last execution
// failed an hour ago looks healthy in the database and is not.
//
// This lives on the cluster's own page rather than in a fleet-wide tab because a mesh is a
// property of a cluster: it is woven between *its* members, repaired with *its* sync button,
// and torn by *its* replication mode. The fleet-wide question — "what has run lately?" — is
// the activity page, which folds these same executions in with the Kubernetes Jobs.

function CatchUpNote({ link }: { link: ReplicationClusterView["links"][number] }) {
  const t = useTranslations("replication")
  const locale = useLocale()
  return <div className="flex flex-col gap-1 text-xs text-muted-foreground">
    <span>{t("catchUpState", { state: link.catchUpRequested ? t("catchUpPending") : link.catchUpStatus ?? "—" })}</span>
    {link.catchUpError && <span className="text-destructive">{link.catchUpError}</span>}
    {link.catchUpError && <span>{t("retryAt", { date: formatDateTime(link.nextAttemptAt, locale) })}</span>}
    {link.lastCatchUpAt && <span>{t("lastCatchUp", { date: formatDateTime(link.lastCatchUpAt, locale) })}</span>}
  </div>
}

const MODE_KEYS: Record<string, "modeEvent" | "modeScheduled" | "modeOff"> = {
  event_based: "modeEvent",
  scheduled: "modeScheduled",
  none: "modeOff",
}

// Harbor's own status vocabulary, which is neither a Gateway enum nor stable-cased across
// releases — matched loosely and rendered through our own three tones rather than passed
// through, so an unexpected value shows up as itself instead of as a colour that lies.
function executionTone(status: string): "success" | "destructive" | "warning" | "muted" {
  const value = status.toLowerCase()
  if (value === "succeed" || value === "succeeded") return "success"
  if (value === "failed" || value === "error") return "destructive"
  if (value === "inprogress" || value === "running" || value === "pending") return "warning"
  return "muted"
}

// `readable` is not decoration: without it "this policy has never run" and "we could not ask
// the source Harbor" render as the same sentence, and the second one is a claim this panel is
// in no position to make.
function ExecutionBadge({
  execution,
  readable = true,
}: {
  execution: ReplicationExecutionView | null
  readable?: boolean
}) {
  const t = useTranslations("replication")
  if (!execution) {
    return (
      <span className="text-xs text-muted-foreground">{readable ? t("neverRun") : t("unknownRun")}</span>
    )
  }

  const tone = executionTone(execution.status)
  const className =
    tone === "success"
      ? "bg-success/15 text-success"
      : tone === "warning"
        ? "bg-warning/15 text-warning"
        : undefined

  return (
    <Badge variant={tone === "destructive" ? "destructive" : tone === "muted" ? "outline" : "default"} className={className}>
      {execution.status}
    </Badge>
  )
}

/** "12 artifacts · 1 failed" — the only place the panel says what actually moved. */
function ExecutionCounts({ execution }: { execution: ReplicationExecutionView }) {
  const t = useTranslations("replication")
  return (
    <span className="text-xs text-muted-foreground">
      {t("artifacts", { count: execution.total })}
      {execution.failed > 0 && <span className="text-destructive"> · {t("failedCount", { count: execution.failed })}</span>}
      {execution.inProgress > 0 && <span className="text-warning"> · {t("inProgressCount", { count: execution.inProgress })}</span>}
    </span>
  )
}

function LinkStatusBadge({ status }: { status: ReplicationClusterView["links"][number]["status"] }) {
  const t = useTranslations("replication")
  if (status === "ACTIVE") return <Badge className="bg-success/15 text-success">{t("linkActive")}</Badge>
  if (status === "FAILED") return <Badge variant="destructive">{t("linkFailed")}</Badge>
  return <Badge className="bg-warning/15 text-warning">{t("linkPending")}</Badge>
}

/**
 * When the *source* Harbor last confirmed it can reach the peer, and at which address.
 *
 * This is the half an operator cannot get anywhere else: the Gateway reaching both Harbors
 * says nothing about one reaching the other, and a link that has never been probed is exactly
 * the shape of the failure that used to sit there looking green.
 */
function ReachabilityNote({ link }: { link: ReplicationClusterView["links"][number] }) {
  const t = useTranslations("replication")
  const locale = useLocale()

  if (!link.lastPingAt) {
    return <span className="text-xs text-muted-foreground">{t("neverPinged")}</span>
  }
  return (
    <span className="text-xs text-muted-foreground">
      {t("pingedAt", { when: formatDateTime(link.lastPingAt, locale) })}
      {link.appliedBaseUrl && <> · {link.appliedBaseUrl}</>}
    </span>
  )
}

function Direction({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
      <span className="truncate font-medium">{from}</span>
      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
        →
      </span>
      <span className="truncate font-medium">{to}</span>
    </span>
  )
}

export function ClusterMeshPanel({ cluster }: { cluster: ReplicationClusterView }) {
  const t = useTranslations("replication")
  const locale = useLocale()
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  async function handleSync() {
    setBusy(true)
    try {
      const res = await fetch(`/api/clusters/${cluster.id}/replication`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("syncFailed")))
        return
      }

      const body = (await res.json()) as { desired: number; failed: number; removed: number }
      if (body.failed > 0) {
        toast.warning(t("syncPartial", { failed: body.failed }))
      } else {
        toast.success(t("syncDone", { links: body.desired, removed: body.removed }))
      }
      router.refresh()
    } catch {
      toast.error(t("syncFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="animate-enter flex flex-col gap-3 px-4 lg:px-6"
      style={{ "--enter-delay": "120ms" } as React.CSSProperties}
    >
      <SubHeader
        title={t("title")}
        description={t("panelDescription")}
        action={
          <Button size="sm" variant="outline" disabled={busy || cluster.memberCount === 0} onClick={handleSync}>
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            {busy ? t("syncing") : t("syncMesh")}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant="outline" className="font-normal">
          {t(MODE_KEYS[cluster.mode] ?? "modeEvent")}
        </Badge>
        {cluster.cron && cluster.mode === "scheduled" && (
          <code className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">{cluster.cron}</code>
        )}
        <span className={cluster.links.length < cluster.expectedLinks ? "text-warning" : undefined}>
          {t("linksOf", { count: cluster.links.length, expected: cluster.expectedLinks })}
        </span>
      </div>

      {cluster.pendingCleanup.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-xs">
          <p>{t("cleanupPending", { count: cluster.pendingCleanup.length })}</p>
          {cluster.pendingCleanup.map((row) => <p key={row.id} className="mt-1 text-muted-foreground">
            {row.lastError} · {t("retryAt", { date: formatDateTime(row.nextAttemptAt, locale) })}
          </p>)}
        </div>
      )}
      {cluster.unreadable.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
          <p className="text-xs font-medium text-warning">{t("unreadableTitle")}</p>
          {cluster.unreadable.map((member) => (
            <p key={member.registryName} className="text-xs leading-5 text-muted-foreground">
              <span className="font-medium">{member.registryName}</span> — {member.error}
            </p>
          ))}
        </div>
      )}

      {cluster.links.length === 0 ? (
        <EmptyState
          title={cluster.mode === "none" ? t("offTitle") : t("noLinksTitle")}
          hint={cluster.mode === "none" ? t("offHint") : t("noLinksHint")}
        />
      ) : (
        <>
          <div className="divide-y overflow-hidden rounded-lg border sm:hidden">
            {cluster.links.map((link) => (
              <article key={link.id} className="flex flex-col gap-2 px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <Direction from={link.sourceName} to={link.destName} />
                  <LinkStatusBadge status={link.status} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ExecutionBadge execution={link.lastExecution} readable={link.executionsReadable} />
                  {link.lastExecution && <ExecutionCounts execution={link.lastExecution} />}
                </div>
                <ReachabilityNote link={link} />
                <CatchUpNote link={link} />
                {link.lastExecution?.startTime && (
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(link.lastExecution.startTime, locale)}
                  </span>
                )}
                {link.lastError && (
                  <p className="rounded-md bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                    {link.lastError}
                  </p>
                )}
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-lg border sm:block">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colDirection")}</TableHead>
                  <TableHead>{t("colPolicy")}</TableHead>
                  <TableHead>{t("colLastRun")}</TableHead>
                  <TableHead>{t("colWhen")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cluster.links.map((link) => (
                  <TableRow key={link.id}>
                    <TableCell>
                      <Direction from={link.sourceName} to={link.destName} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <LinkStatusBadge status={link.status} />
                        {link.lastError && (
                          <span className="max-w-xs text-xs text-destructive">{link.lastError}</span>
                        )}
                        <ReachabilityNote link={link} />
                <CatchUpNote link={link} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <ExecutionBadge execution={link.lastExecution} readable={link.executionsReadable} />
                        {link.lastExecution && <ExecutionCounts execution={link.lastExecution} />}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {link.lastExecution?.startTime
                        ? formatDateTime(link.lastExecution.startTime, locale)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {cluster.recent.length > 0 && (
        <details className="rounded-lg border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t("recentTitle", { count: cluster.recent.length })}
          </summary>
          <ul className="mt-3 flex flex-col divide-y">
            {cluster.recent.map((run) => (
              <li
                key={`${run.sourceRegistryId}-${run.id}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ExecutionBadge execution={run} />
                  <Direction from={run.sourceName} to={run.destName} />
                  <span className="text-xs text-muted-foreground">{run.trigger}</span>
                </div>
                <div className="flex items-center gap-2">
                  <ExecutionCounts execution={run} />
                  <span className="text-xs text-muted-foreground">
                    {run.startTime ? formatDateTime(run.startTime, locale) : "—"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-md bg-muted">
        <ServerOff className="size-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}
