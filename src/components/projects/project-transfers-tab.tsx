"use client"

import * as React from "react"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"

import { useTransferSync } from "@/hooks/use-live-refresh"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  RequestTransferDialog,
  type TransferDestinationOption,
  type TransferSourceRegistry,
} from "@/components/transfers/request-transfer-dialog"
import type { PickableSource } from "@/lib/sources/public"

type TransferStatusValue = "PENDING" | "APPROVED" | "REJECTED" | "RUNNING" | "SUCCEEDED" | "FAILED"

// One destination of a pull, as this project sees it.
export interface TransferTargetItem {
  id: string
  sourceImage: string
  sourceName: string | null
  targetRepo: string | null
  status: TransferStatusValue
  errorMessage: string | null
  transferRequestId: string
}

function StatusBadge({ status }: { status: TransferStatusValue }) {
  const t = useTranslations("projects.transfers")
  const variants: Record<TransferStatusValue, { className: string; label: string }> = {
    PENDING: { className: "bg-warning/15 text-warning", label: t("statusPending") },
    APPROVED: { className: "bg-muted text-muted-foreground", label: t("statusApproved") },
    RUNNING: { className: "bg-muted text-muted-foreground", label: t("statusRunning") },
    SUCCEEDED: { className: "bg-success/15 text-success", label: t("statusSucceeded") },
    FAILED: { className: "", label: t("statusFailed") },
    REJECTED: { className: "", label: t("statusRejected") },
  }
  const v = variants[status]
  if (status === "FAILED" || status === "REJECTED") {
    return <Badge variant="destructive">{v.label}</Badge>
  }
  return <Badge className={v.className}>{v.label}</Badge>
}

// Reviewing a transfer happens in Admin › Requests, alongside project requests — this tab shows
// what has landed in *this* project, and offers the same dialog the Projects header does,
// with this project already ticked.
export function ProjectTransfersTab({
  projectId,
  targets,
  sources,
  sourceRegistries,
  destinations,
  isActive,
  canTransferDirectly = false,
  hasEnterpriseCa = false,
  enterpriseCaJobDefault = true,
  k8sEnabled = true,
}: {
  projectId: string
  targets: TransferTargetItem[]
  sources: PickableSource[]
  sourceRegistries?: TransferSourceRegistry[]
  destinations: TransferDestinationOption[]
  isActive: boolean
  canTransferDirectly?: boolean
  hasEnterpriseCa?: boolean
  enterpriseCaJobDefault?: boolean
  k8sEnabled?: boolean
}) {
  const t = useTranslations("projects.transfers")
  const tTransfers = useTranslations("transfers")
  const disabledReason = !k8sEnabled
    ? tTransfers("disabledReason")
    : !isActive
      ? t("availableOnceActive")
      : undefined
  const unavailableReason = disabledReason ?? (sources.length === 0 ? t("noSource") : undefined)

  // One sync per request, not per target — the endpoint settles every running destination.
  useTransferSync(
    targets.filter((target) => target.status === "RUNNING").map((target) => target.transferRequestId),
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-stretch gap-2 sm:items-end">
        <RequestTransferDialog
          sources={sources}
          sourceRegistries={sourceRegistries}
          destinations={destinations}
          defaultProjectId={projectId}
          canTransferDirectly={canTransferDirectly}
      hasEnterpriseCa={hasEnterpriseCa}
      enterpriseCaJobDefault={enterpriseCaJobDefault}
          disabledReason={disabledReason}
          trigger={
            <Button
              disabled={Boolean(unavailableReason)}
              className="w-full sm:w-auto"
            >
              <Download />
              {canTransferDirectly ? tTransfers("transferTrigger") : tTransfers("requestTrigger")}
            </Button>
          }
        />
        {unavailableReason && (
          <p className="max-w-md text-xs leading-5 text-muted-foreground" role="note">
            {unavailableReason}
          </p>
        )}
      </div>

      {targets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-12 py-10 text-center sm:px-5 sm:py-14">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <Download className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {targets.map((target) => (
            <div key={target.id} className="flex flex-col items-stretch gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-sm">{target.sourceImage}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {target.sourceName ? `${target.sourceName} · ` : ""}
                  {target.targetRepo ? `→ ${target.targetRepo}` : t("sameName")}
                </span>
                {target.errorMessage && (
                  <span className="line-clamp-2 text-xs leading-5 text-destructive" title={target.errorMessage}>
                    {target.errorMessage}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
                <StatusBadge status={target.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
