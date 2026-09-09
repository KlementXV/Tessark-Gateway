"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Activity,
  ArrowRight,
  CalendarClock,
  FileText,
  Network,
  RefreshCw,
  Send,
  TriangleAlert,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MetricGrid } from "@/components/ui/metric-grid"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useLiveRefresh } from "@/hooks/use-live-refresh"
import { extractErrorMessage } from "@/lib/api-error"
import { formatDateTime } from "@/lib/format-date"
import type { ActivityEntry, ActivityKind, ActivityView } from "@/lib/activity/view"

type LogState =
  | { status: "loading" }
  | { status: "ok"; text: string; podName: string }
  | { status: "empty"; reason: string }
  | { status: "error"; error: string }

type Filter = "all" | ActivityKind

const FILTERS: Array<{ value: Filter; labelKey: "filterAll" | "filterTransfers" | "filterMirrors" | "filterMesh" | "filterOrphans" | "filterBuilds" }> = [
  { value: "all", labelKey: "filterAll" },
  { value: "transfer", labelKey: "filterTransfers" },
  { value: "mirror", labelKey: "filterMirrors" },
  { value: "build", labelKey: "filterBuilds" },
  { value: "mesh", labelKey: "filterMesh" },
  { value: "orphan", labelKey: "filterOrphans" },
]

function StatusBadge({ status }: { status: ActivityEntry["status"] }) {
  const t = useTranslations("activity")
  if (status === "succeeded") return <Badge className="bg-success/15 text-success">{t("statusSucceeded")}</Badge>
  if (status === "failed") return <Badge variant="destructive">{t("statusFailed")}</Badge>
  if (status === "running") return <Badge className="bg-warning/15 text-warning">{t("statusRunning")}</Badge>
  return <Badge variant="outline">{t("statusUnknown")}</Badge>
}

function KindBadge({ entry }: { entry: ActivityEntry }) {
  const t = useTranslations("activity")
  if (entry.kind === "orphan") return <Badge variant="destructive">{t("kindOrphan")}</Badge>
  const key = entry.kind === "transfer" ? "kindTransfer" : entry.kind === "mirror" ? "kindMirror" : entry.kind === "build" ? "kindBuild" : "kindMesh"
  return (
    <Badge variant="outline" className="font-normal">
      {t(key)}
    </Badge>
  )
}

export function ActivityBoard({ view }: { view: ActivityView }) {
  const t = useTranslations("activity")
  const locale = useLocale()
  const router = useRouter()
  const [filter, setFilter] = React.useState<Filter>("all")
  const [logsFor, setLogsFor] = React.useState<string | null>(null)
  const [logs, setLogs] = React.useState<LogState | null>(null)

  const { entries } = view
  const running = entries.filter((entry) => entry.status === "running")

  // A running Job changes state on its own, so the page polls while anything is in flight and
  // stops as soon as nothing is — an idle console must not keep a cluster busy answering, and
  // each of these ticks reaches Kubernetes and every Harbor.
  useLiveRefresh(running.map((entry) => entry.id).join(","))

  const counts = React.useMemo(() => {
    const byKind: Record<Filter, number> = { all: entries.length, transfer: 0, mirror: 0, build: 0, mesh: 0, orphan: 0 }
    for (const entry of entries) byKind[entry.kind] += 1
    return byKind
  }, [entries])

  const visible = filter === "all" ? entries : entries.filter((entry) => entry.kind === filter)

  async function openLogs(name: string) {
    setLogsFor(name)
    setLogs({ status: "loading" })
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(name)}/logs`)
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setLogs({ status: "error", error: extractErrorMessage(body, t("logsFailed")) })
        return
      }
      setLogs(
        body.status === "ok"
          ? { status: "ok", text: body.text, podName: body.podName }
          : { status: "empty", reason: body.reason },
      )
    } catch {
      setLogs({ status: "error", error: t("logsFailed") })
    }
  }

  return (
    <>
      <MetricGrid
        className="mx-4 lg:mx-6"
        metrics={[
          { icon: Activity, label: t("metricTotal"), value: entries.length },
          {
            label: t("metricRunning"),
            value: running.length,
            tone: running.length > 0 ? "warning" : "default",
          },
          {
            label: t("metricFailed"),
            value: entries.filter((entry) => entry.status === "failed").length,
            tone: entries.some((entry) => entry.status === "failed") ? "destructive" : "default",
          },
          {
            label: t("metricOrphans"),
            value: counts.orphan,
            tone: counts.orphan > 0 ? "warning" : "default",
          },
        ]}
      />

      {/* What could not be read, one line each. An engine that stayed silent is a fact about
          the fleet, not a reason to render an empty page as if nothing had run. */}
      {view.notices.length > 0 && (
        <div className="mx-4 flex flex-col gap-2 lg:mx-6">
          {view.notices.map((notice, index) => (
            <p
              key={index}
              role="status"
              className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 break-words">
                {notice.kind === "k8sDisabled"
                  ? t("noticeK8sDisabled")
                  : notice.kind === "k8sError"
                    ? t("noticeK8sError", { detail: notice.detail })
                    : notice.kind === "mirrorsUnreadable"
                      ? t("noticeMirrorsUnreadable", { detail: notice.detail })
                      : notice.kind === "meshUnreadable"
                        ? t("noticeMeshUnreadable", { detail: notice.detail })
                        : t("noticeHarborError", { subject: notice.subject, detail: notice.detail })}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 border-y px-4 py-3 @3xl/main:flex-row @3xl/main:items-center lg:px-6">
        <div className="scrollbar-none -mx-1 flex max-w-full overflow-x-auto px-1 py-0.5 @3xl/main:mx-0 @3xl/main:flex-1">
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/70 p-1"
            role="group"
            aria-label={t("filterAria")}
          >
            {FILTERS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={filter === option.value ? "outline" : "ghost"}
                size="sm"
                className="h-7 shrink-0 px-2 shadow-none"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {t(option.labelKey)}
                <span className="text-xs tabular-nums opacity-60">{counts[option.value]}</span>
              </Button>
            ))}
          </div>
        </div>

        {/* The retention window is stated on the page, not just in a comment: a page that
            silently forgets an hour of history would otherwise read as one that lost it. */}
        <p className="shrink-0 text-xs text-muted-foreground">
          {view.namespace ? t("windowHint", { namespace: view.namespace }) : t("windowHintNoCluster")}
        </p>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => router.refresh()}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t("refresh")}
        </Button>
      </div>

      <div className="flex flex-col gap-3 px-4 lg:px-6">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <div className="flex size-11 items-center justify-center rounded-md bg-muted">
              <Activity className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{entries.length === 0 ? t("emptyTitle") : t("noMatchTitle")}</p>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                {entries.length === 0 ? t("emptyHint") : t("noMatchHint")}
              </p>
            </div>
          </div>
        ) : (
          visible.map((entry, index) => (
            <article
              key={entry.id}
              className="animate-enter flex flex-col gap-3 rounded-lg border px-4 py-3.5 @xl/main:flex-row @xl/main:items-start @xl/main:justify-between"
              style={{ "--enter-delay": `${Math.min(index, 8) * 40}ms` } as React.CSSProperties}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={entry.status} />
                  <KindBadge entry={entry} />
                  <code className="truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {entry.title}
                  </code>
                </div>

                {entry.source && entry.destination && (
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <span className="truncate">{entry.source}</span>
                    <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{entry.destination}</span>
                  </div>
                )}

                <p className="mt-1.5 text-xs text-muted-foreground">
                  {entry.startTime ? t("startedAt", { at: formatDateTime(entry.startTime, locale) }) : t("notStarted")}
                  {entry.endTime && ` · ${t("endedAt", { at: formatDateTime(entry.endTime, locale) })}`}
                  {entry.detail && ` · ${entry.detail}`}
                </p>

                {/* The whole reason a transfer can look stuck: the Job is settled but nobody
                    has opened the request, so its row still says RUNNING. Saying so here is
                    more honest than quietly showing the Kubernetes phase alone. */}
                {entry.stale && <p className="mt-1.5 text-xs text-warning">{t("notReconciled")}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-1 self-end @xl/main:self-auto">
                {entry.href && (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={entry.href}>
                      {entry.kind === "transfer" ? (
                        <Send className="size-3.5" aria-hidden="true" />
                      ) : entry.kind === "mesh" ? (
                        <Network className="size-3.5" aria-hidden="true" />
                      ) : (
                        <CalendarClock className="size-3.5" aria-hidden="true" />
                      )}
                      {entry.kind === "transfer"
                        ? t("openTransfer")
                        : entry.kind === "mesh"
                          ? t("openCluster")
                          : t("openMirror")}
                    </Link>
                  </Button>
                )}
                {/* Only Kubernetes hands out logs. A Harbor execution's detail is the counts
                    already shown; offering a button that could only say "no logs here" would
                    be worse than not offering one. */}
                {entry.jobName && (
                  <Button size="sm" variant="outline" onClick={() => openLogs(entry.jobName!)}>
                    <FileText className="size-3.5" aria-hidden="true" />
                    {t("logs")}
                  </Button>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <Sheet open={logsFor !== null} onOpenChange={(open) => !open && setLogsFor(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">{logsFor}</SheetTitle>
            <SheetDescription>
              {logs?.status === "ok" ? t("logsPod", { pod: logs.podName }) : t("logsDescription")}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
            {logs?.status === "loading" && <p className="text-sm text-muted-foreground">{t("logsLoading")}</p>}
            {logs?.status === "empty" && <p className="text-sm text-muted-foreground">{logs.reason}</p>}
            {logs?.status === "error" && <p className="text-sm text-destructive">{logs.error}</p>}
            {logs?.status === "ok" && (
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
                {logs.text.trim() || t("logsEmpty")}
              </pre>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
