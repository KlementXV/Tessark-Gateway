"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Infinity as InfinityIcon, RefreshCw, Send, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const GIB = 1024

interface MemberQuota {
  registryId: string
  registryName: string
  hardBytes: number | null
  usedBytes: number | null
  error: string | null
}

function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function ProjectQuotaTab({
  projectId,
  storageQuotaMib,
  canEdit,
  canRequest,
  pendingRequest,
  isActive,
}: {
  projectId: string
  storageQuotaMib: number | null
  /** Global ADMIN: may set the limit outright. */
  canEdit: boolean
  /** Manager of this project: may ask an admin for a different limit. */
  canRequest: boolean
  pendingRequest: { requestedQuotaMib: number | null } | null
  isActive: boolean
}) {
  const t = useTranslations("projects.quota")
  const tc = useTranslations("common")
  const router = useRouter()
  const [limited, setLimited] = React.useState(storageQuotaMib !== null)
  // Edited in GiB — the unit an admin thinks in — and converted at the boundary. MiB is only
  // how it is stored, so that a quota under a gigabyte stays expressible.
  const [quotaGib, setQuotaGib] = React.useState(
    storageQuotaMib === null ? "50" : String(storageQuotaMib / GIB)
  )
  const [savedQuota, setSavedQuota] = React.useState(() => ({
    limited: storageQuotaMib !== null,
    quotaGib: storageQuotaMib === null ? "50" : String(storageQuotaMib / GIB),
  }))
  const [submitting, setSubmitting] = React.useState(false)
  // A manager edits the same two controls an admin does; the form just submits an ask
  // instead of the change itself.
  const editable = canEdit || (canRequest && !pendingRequest)
  const [requesting, setRequesting] = React.useState(false)
  const [requestOpen, setRequestOpen] = React.useState(false)
  const [requestReason, setRequestReason] = React.useState("")
  const [members, setMembers] = React.useState<MemberQuota[] | null>(null)
  const [usageError, setUsageError] = React.useState<string | null>(null)
  const dirty = limited !== savedQuota.limited || (limited && quotaGib !== savedQuota.quotaGib)
  useUnsavedChanges(dirty && !submitting)

  // Consumption is never stored, only read back from each Harbor — see the GET handler.
  const usageFailed = t("usageFailed")
  const loadUsage = React.useCallback(async () => {
    if (!isActive) return
    setMembers(null)
    setUsageError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/quota`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(extractErrorMessage(body, usageFailed))
      }
      const body = (await res.json()) as { members: MemberQuota[] }
      setMembers(body.members)
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : usageFailed)
    }
  }, [isActive, projectId, usageFailed])

  React.useEffect(() => {
    if (!isActive) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading starts with this external fetch
    void loadUsage()
  }, [isActive, loadUsage])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const parsed = Number(quotaGib)
    if (limited && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast.error(t("invalidLimit"))
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageQuotaMib: limited ? Math.round(parsed * GIB) : null,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("updateFailed")))
        return
      }

      const body = (await res.json()) as {
        placements: { failed: number; failures: Array<{ registry: string; error: string }> }
      }
      if (body.placements.failed > 0) {
        toast.warning(
          t("savedPartial", { registries: body.placements.failures.map((f) => f.registry).join(", ") })
        )
      } else {
        toast.success(limited ? t("saved") : t("limitRemoved"))
      }

      setSavedQuota({ limited, quotaGib })
      void loadUsage()
      router.refresh()
    } catch {
      toast.error(t("updateFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  // A manager's submit doesn't touch the project: it writes a QuotaRequest an admin reviews
  // from the queue, so the form's own values stay dirty until the ask is approved.
  async function handleRequest() {
    const parsed = Number(quotaGib)
    if (limited && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast.error(t("invalidLimit"))
      return
    }

    setRequesting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/quota/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageQuotaMib: limited ? Math.round(parsed * GIB) : null,
          reason: requestReason,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("requestFailed")))
        return
      }

      toast.success(t("requestSubmitted"))
      setRequestOpen(false)
      setRequestReason("")
      router.refresh()
    } catch {
      toast.error(t("requestFailed"))
    } finally {
      setRequesting(false)
    }
  }

  if (!isActive) {
    return (
      <div className="rounded-lg border border-dashed px-5 py-14 text-center text-sm text-muted-foreground">
        {t("inactive")}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
          <div className="min-w-0">
            <Label htmlFor="quota-limited" className="text-sm font-medium">
              {t("limitStorage")}
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("limitHint")}
            </p>
          </div>
          <Switch
            id="quota-limited"
            checked={limited}
            disabled={!editable}
            onCheckedChange={setLimited}
          />
        </div>

        {limited && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="quota-gib">{t("limitLabel")}</Label>
            <Input
              id="quota-gib"
              type="number"
              min={0.1}
              step={0.1}
              disabled={!editable}
              value={quotaGib}
              onChange={(e) => setQuotaGib(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("limitNote")}
            </p>
          </div>
        )}

        {canEdit ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="submit" disabled={submitting || !dirty} className="w-full sm:w-fit">
              {submitting ? tc("saving") : dirty ? t("saveQuota") : t("upToDate")}
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">{t("unsavedChanges")}</span>}
          </div>
        ) : canRequest ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t("managerHint")}</p>
            {pendingRequest ? (
              <p className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
                {t("pendingRequest", {
                  quota:
                    pendingRequest.requestedQuotaMib === null
                      ? t("unlimited")
                      : t("gib", { value: pendingRequest.requestedQuotaMib / GIB }),
                })}
              </p>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-fit"
                disabled={!dirty}
                onClick={() => setRequestOpen(true)}
              >
                <Send />
                {t("requestChange")}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("adminOnly")}
          </p>
        )}
      </form>

      <Dialog
        open={requestOpen}
        onOpenChange={(open) => {
          setRequestOpen(open)
          if (!open) setRequestReason("")
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("requestTitle")}</DialogTitle>
            <DialogDescription>
              {t("requestDescription", {
                quota: limited ? t("gib", { value: Number(quotaGib) }) : t("unlimited"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="quota-request-reason">{t("requestReason")}</Label>
            <Textarea
              id="quota-request-reason"
              value={requestReason}
              onChange={(e) => setRequestReason(e.target.value)}
              placeholder={t("requestReasonPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button disabled={requesting} onClick={() => void handleRequest()}>
              <Send />
              {requesting ? t("requesting") : t("requestSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("usageTitle")}</p>
        {usageError ? (
          <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-destructive">{t("usageUnavailable")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{usageError}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadUsage()}>
              <RefreshCw />
              {t("retry")}
            </Button>
          </div>
        ) : members === null ? (
          <div className="flex flex-col gap-2" aria-label={t("readingUsage")}>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noHarbor")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {members.map((member) => {
              const unlimited = member.hardBytes === null || member.hardBytes < 0
              const ratio =
                !unlimited && member.usedBytes !== null && member.hardBytes! > 0
                  ? Math.min(member.usedBytes / member.hardBytes!, 1)
                  : null

              return (
                <li key={member.registryId} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate text-sm">{member.registryName}</span>
                    {member.error ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-warning">
                        <TriangleAlert className="size-3.5" />
                        {t("unavailable")}
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatBytes(member.usedBytes ?? 0)}
                        {unlimited ? (
                          <span className="inline-flex items-center gap-1">
                            {" / "}
                            <InfinityIcon className="size-3" />
                          </span>
                        ) : (
                          ` / ${formatBytes(member.hardBytes!)}`
                        )}
                      </span>
                    )}
                  </div>
                  {ratio !== null && (
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${ratio > 0.9 ? "bg-warning" : "bg-foreground/70"}`}
                        style={{ width: `${Math.max(ratio * 100, 1)}%` }}
                      />
                    </div>
                  )}
                  {member.error && <p className="text-xs text-muted-foreground">{member.error}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
