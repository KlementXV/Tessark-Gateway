"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Copy, RefreshCw, Server } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { clusterImageReference } from "@/lib/clusters/registry-url"
import { copyToClipboard } from "@/lib/clipboard"
import { formatDateTime } from "@/lib/format-date"

export interface HarborPlacement {
  registryId: string
  registryName: string
  baseUrl: string
  harborProjectId: number | null
  status: "PENDING" | "ACTIVE" | "FAILED" | "MISSING"
  lastError: string | null
  syncedAt: string | null
}

function PlacementBadge({ status }: { status: HarborPlacement["status"] }) {
  const t = useTranslations("projects.harbors")
  if (status === "ACTIVE") return <Badge className="bg-success/15 text-success">{t("inSync")}</Badge>
  if (status === "FAILED") return <Badge variant="destructive">{t("failed")}</Badge>
  // MISSING is a member that joined after the project was approved and hasn't been
  // reconciled yet — pending work rather than an error.
  return <Badge className="bg-warning/15 text-warning">{t("queued")}</Badge>
}

export function ProjectHarborsTab({
  clusterId,
  clusterName,
  clusterRegistryUrl,
  projectName,
  replicationMode,
  placements,
  isManager,
}: {
  clusterId: string
  clusterName: string
  /** The cluster's published host, when one is configured. Null falls back to per-member URLs. */
  clusterRegistryUrl: string | null
  projectName: string
  replicationMode: string
  placements: HarborPlacement[]
  isManager: boolean
}) {
  const t = useTranslations("projects.harbors")
  const locale = useLocale()
  const router = useRouter()
  const [reconciling, setReconciling] = React.useState(false)

  const behind = placements.filter((p) => p.status !== "ACTIVE").length
  const pullCommand = clusterRegistryUrl
    ? `docker pull ${clusterImageReference(clusterRegistryUrl, projectName, "<repository>", "<tag>")}`
    : null

  async function handleReconcile() {
    setReconciling(true)
    try {
      const res = await fetch(`/api/clusters/${clusterId}/reconcile`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("reconcileFailed")))
        return
      }

      const body = (await res.json()) as { replayed: number; remaining: number; unreachable: number }
      if (body.remaining === 0 && body.unreachable === 0) {
        toast.success(body.replayed > 0 ? t("replayed", { count: body.replayed }) : t("allInSync"))
      } else {
        toast.warning(
          t("replayedPartial", {
            replayed: body.replayed,
            remaining: body.remaining,
            unreachable: body.unreachable,
          })
        )
      }
      router.refresh()
    } catch {
      toast.error(t("reconcileFailed"))
    } finally {
      setReconciling(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t.rich("livesOn", {
            cluster: clusterName,
            b: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}{" "}
          {replicationMode === "none"
            ? t("replicationNone")
            : replicationMode === "scheduled"
              ? t("replicationScheduled")
              : t("replicationEvent")}
        </p>
        {isManager && behind > 0 && (
          <Button size="sm" variant="outline" disabled={reconciling} onClick={handleReconcile}>
            <RefreshCw className={reconciling ? "animate-spin" : undefined} />
            {reconciling ? t("reconciling") : t("reconcileNow")}
          </Button>
        )}
      </div>

      {pullCommand && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/25 px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium">{t("pullFrom")}</span>
            <span className="text-xs text-muted-foreground">
              {t("resolvesClosest")}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-background p-2 pl-3">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
              {pullCommand}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("copyPullCommand")}
              onClick={() =>
                void copyToClipboard(pullCommand).then((ok) =>
                  ok ? toast.success(t("pullCommandCopied")) : toast.error(t("copyFailed")),
                )
              }
            >
              <Copy />
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("perMemberNote")}
          </p>
        </div>
      )}

      {placements.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-12 py-10 text-center sm:px-5 sm:py-14">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <Server className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="divide-y overflow-hidden rounded-lg border sm:hidden">
            {placements.map((placement) => (
              <article key={placement.registryId} className="flex flex-col gap-3 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{placement.registryName}</p>
                    <p className="mt-0.5 break-all text-xs text-muted-foreground">{placement.baseUrl}</p>
                  </div>
                  <PlacementBadge status={placement.status} />
                </div>
                {placement.lastError && (
                  <p className="rounded-md bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                    {placement.lastError}
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t("colProjectId")}</dt>
                    <dd className="mt-0.5 font-medium">{placement.harborProjectId ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("colLastSynced")}</dt>
                    <dd className="mt-0.5 font-medium">
                      {placement.syncedAt ? formatDateTime(placement.syncedAt, locale) : "—"}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-lg border sm:block">
            <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("colHarbor")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colProjectId")}</TableHead>
                <TableHead>{t("colLastSynced")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {placements.map((placement) => (
                <TableRow key={placement.registryId}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{placement.registryName}</span>
                      <span className="text-xs text-muted-foreground">{placement.baseUrl}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <PlacementBadge status={placement.status} />
                      {placement.lastError && (
                        <span className="max-w-xs text-xs text-destructive">{placement.lastError}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {placement.harborProjectId ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {placement.syncedAt ? formatDateTime(placement.syncedAt, locale) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
