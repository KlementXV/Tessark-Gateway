"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowRight, CalendarClock, PlayCircle, RefreshCw, Timer, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
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
import { MetricGrid } from "@/components/ui/metric-grid"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MirrorEditDialog } from "@/components/mirrors/mirror-edit-dialog"
import { useLiveRefresh } from "@/hooks/use-live-refresh"
import { extractErrorMessage } from "@/lib/api-error"
import { formatDateTime, formatRelativeTime } from "@/lib/format-date"
import type { MirrorRunStatus, MirrorWithRuns } from "@/lib/mirrors/view"

function RunBadge({ status }: { status: MirrorRunStatus }) {
  const t = useTranslations("mirrors")
  if (status === "succeeded") return <Badge className="bg-success/15 text-success">{t("runSucceeded")}</Badge>
  if (status === "failed") return <Badge variant="destructive">{t("runFailed")}</Badge>
  if (status === "running") return <Badge className="bg-warning/15 text-warning">{t("runRunning")}</Badge>
  return <Badge variant="outline">{t("runUnknown")}</Badge>
}

/**
 * When this mirror fires next.
 *
 * The absolute UTC time is rendered on the server and is what the markup carries; the "in 4
 * hours" reading only appears after mount, because it depends on the current instant and
 * would otherwise differ between server and browser and tear the tree down on hydration
 * (see formatRelativeTime). It re-reads every half minute so a page left open stops lying.
 */
function NextRun({ at }: { at: string }) {
  const t = useTranslations("mirrors")
  const locale = useLocale()
  const [relative, setRelative] = React.useState<string | null>(null)

  React.useEffect(() => {
    const update = () => setRelative(formatRelativeTime(at, locale))
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [at, locale])

  const absolute = formatDateTime(at, locale)
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      title={t("nextRunAt", { at: absolute })}
    >
      <Timer className="size-3.5 shrink-0" aria-hidden="true" />
      {relative ? t("nextRunIn", { relative }) : t("nextRunAt", { at: absolute })}
    </span>
  )
}

export function MirrorsBoard({ mirrors }: { mirrors: MirrorWithRuns[] }) {
  const t = useTranslations("mirrors")
  const locale = useLocale()
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | null>(null)

  // A run started by "Run now" — or by the schedule while the page sits open — is read back
  // from its transport on every render, so re-rendering is all it takes to settle it. Without
  // this the badge stayed on "running" until somebody reloaded by hand.
  useLiveRefresh(
    mirrors
      .filter((mirror) => mirror.runs.some((run) => run.status === "running"))
      .map((mirror) => mirror.id)
      .join(","),
  )

  const active = mirrors.filter((mirror) => mirror.enabled && mirror.applied).length
  const broken = mirrors.filter((mirror) => !mirror.applied).length
  const failingRuns = mirrors.filter((mirror) => mirror.runs[0]?.status === "failed").length

  async function call(
    mirror: MirrorWithRuns,
    run: () => Promise<Response>,
    success: string,
    fallback: string,
  ) {
    setBusyId(mirror.id)
    try {
      const res = await run()
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, fallback))
        return
      }
      toast.success(success)
      router.refresh()
    } catch {
      toast.error(fallback)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <MetricGrid
        className="mx-4 lg:mx-6"
        metrics={[
          { icon: CalendarClock, label: t("metricMirrors"), value: mirrors.length },
          { label: t("metricActive"), value: active },
          {
            label: t("metricNotInstalled"),
            value: broken,
            tone: broken > 0 ? "destructive" : "default",
          },
          {
            label: t("metricFailingRuns"),
            value: failingRuns,
            tone: failingRuns > 0 ? "warning" : "default",
          },
        ]}
      />

      <div className="flex flex-col gap-3 px-4 lg:px-6">
        {mirrors.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <div className="flex size-11 items-center justify-center rounded-md bg-muted">
              <CalendarClock className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("emptyTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
            </div>
          </div>
        ) : (
          mirrors.map((mirror, index) => (
            <article
              key={mirror.id}
              className="animate-enter flex flex-col gap-3 rounded-lg border px-4 py-3.5"
              style={{ "--enter-delay": `${Math.min(index, 8) * 40}ms` } as React.CSSProperties}
            >
              <div className="flex flex-col gap-3 @xl/main:flex-row @xl/main:items-start @xl/main:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">{mirror.name}</h2>
                    <Badge variant="outline" className="font-normal">
                      {mirror.transport === "harbor" ? t("transportHarbor") : t("transportSkopeo")}
                    </Badge>
                    <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {mirror.schedule}
                    </code>
                    {!mirror.applied && <Badge variant="destructive">{t("notInstalled")}</Badge>}
                    {mirror.applied && mirror.enabled && mirror.suspended && (
                      <Badge className="bg-warning/15 text-warning">{t("suspended")}</Badge>
                    )}
                    {/* Only when it is actually going to happen: a paused or uninstalled
                        mirror has no next run, and showing one would be a promise the
                        transport is not keeping. */}
                    {mirror.nextRunAt && <NextRun at={mirror.nextRunAt} />}
                  </div>

                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <span className="truncate">{mirror.sourceImage}</span>
                    <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                    {mirror.destinationHref ? (
                      <Link href={mirror.destinationHref} className="truncate underline-offset-2 hover:underline">
                        {mirror.destination}
                      </Link>
                    ) : (
                      <span className="truncate">{mirror.destination}</span>
                    )}
                  </div>

                  {mirror.transportObject && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{mirror.transportObject}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1 self-end @xl/main:self-auto">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="mr-1 inline-flex">
                        <Switch
                          checked={mirror.enabled}
                          disabled={busyId === mirror.id}
                          aria-label={t("toggleAria", { name: mirror.name })}
                          onCheckedChange={(checked) =>
                            call(
                              mirror,
                              () =>
                                fetch(`/api/mirrors/${mirror.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ enabled: checked }),
                                }),
                              checked ? t("resumed") : t("paused"),
                              t("updateFailed"),
                            )
                          }
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t("toggleHint")}</TooltipContent>
                  </Tooltip>

                  <MirrorEditDialog mirror={mirror} />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busyId === mirror.id}
                        aria-label={t("runNowAria", { name: mirror.name })}
                        onClick={() =>
                          call(
                            mirror,
                            () => fetch(`/api/mirrors/${mirror.id}/run`, { method: "POST" }),
                            t("runStarted"),
                            t("runFailedToast"),
                          )
                        }
                      >
                        <PlayCircle />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t("runNow")}</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busyId === mirror.id}
                        aria-label={t("reapplyAria", { name: mirror.name })}
                        onClick={() =>
                          call(
                            mirror,
                            () => fetch(`/api/mirrors/${mirror.id}/apply`, { method: "POST" }),
                            t("reapplied"),
                            t("reapplyFailed"),
                          )
                        }
                      >
                        <RefreshCw className={busyId === mirror.id ? "animate-spin" : undefined} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t("reapply")}</TooltipContent>
                  </Tooltip>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        aria-label={t("deleteAria", { name: mirror.name })}
                      >
                        <Trash2 />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("deleteTitle", { name: mirror.name })}</AlertDialogTitle>
                        <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            call(
                              mirror,
                              () => fetch(`/api/mirrors/${mirror.id}`, { method: "DELETE" }),
                              t("deleted"),
                              t("deleteFailed"),
                            )
                          }
                        >
                          {t("delete")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>

              {mirror.lastError && (
                <p className="rounded-md bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                  {mirror.lastError}
                </p>
              )}

              {mirror.runsError ? (
                <p className="text-xs text-muted-foreground">
                  {t("runsUnreadable", { error: mirror.runsError })}
                </p>
              ) : mirror.runs.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noRuns")}</p>
              ) : (
                <ul className="flex flex-col divide-y border-t pt-1">
                  {mirror.runs.map((run) => (
                    <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <RunBadge status={run.status} />
                        {run.detail && (
                          <span className="font-mono text-xs text-muted-foreground">{run.detail}</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {run.startTime ? formatDateTime(run.startTime, locale) : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))
        )}
      </div>
    </>
  )
}
