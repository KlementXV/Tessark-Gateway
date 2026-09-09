"use client"

import * as React from "react"
import Link from "next/link"
import { Boxes, Download, HardDrive, Inbox, Send, Trash2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import type { RequestItem, RequestStatus } from "@/lib/requests/service"
import { formatDate } from "@/lib/format-date"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** The label of a request status, shared with the history filter so both agree. */
export function useRequestStatusLabel() {
  const t = useTranslations("requests")
  return (status: RequestStatus) => {
    switch (status) {
      case "PENDING":
        return t("statusPending")
      case "ACTIVE":
        return t("statusApproved")
      case "SUCCEEDED":
        return t("statusSucceeded")
      case "RUNNING":
        return t("statusRunning")
      case "APPROVED":
        return t("statusApproved")
      case "FAILED":
        return t("statusFailed")
      default:
        return t("statusRejected")
    }
  }
}

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const label = useRequestStatusLabel()(status)
  switch (status) {
    case "PENDING":
      return <Badge className="bg-warning/15 text-warning">{label}</Badge>
    case "ACTIVE":
    case "SUCCEEDED":
      return <Badge className="bg-success/15 text-success">{label}</Badge>
    case "RUNNING":
    case "APPROVED":
      return <Badge className="bg-muted text-muted-foreground">{label}</Badge>
    default:
      return <Badge variant="destructive">{label}</Badge>
  }
}

const KIND_ICON = {
  PROJECT: Boxes,
  TRANSFER: Download,
  QUOTA: HardDrive,
  PROJECT_DELETE: Trash2,
} as const
const KIND_LABEL = {
  PROJECT: "kindProject",
  TRANSFER: "kindTransfer",
  QUOTA: "kindQuota",
  PROJECT_DELETE: "kindProjectDelete",
} as const

function KindBadge({ kind }: { kind: RequestItem["kind"] }) {
  const t = useTranslations("requests")
  const Icon = KIND_ICON[kind]
  return (
    // A deletion is the one kind whose badge is drawn in the destructive tone: it is the only
    // request in this queue that destroys something, and a reviewer scanning the list should
    // not have to read the label to notice.
    <Badge
      variant="outline"
      className={cn("gap-1", kind === "PROJECT_DELETE" && "border-destructive/40 text-destructive")}
    >
      <Icon className="size-3" />
      {t(KIND_LABEL[kind])}
    </Badge>
  )
}

export function RequestsEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="animate-enter mx-4 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-20 text-center lg:mx-6">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}

export function RequestRow({
  item,
  index,
  actions,
}: {
  item: RequestItem
  index: number
  actions?: React.ReactNode
}) {
  const t = useTranslations("requests")
  const locale = useLocale()
  return (
    <div
      className="animate-enter flex flex-col items-stretch gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      style={{ "--enter-delay": `${Math.min(index, 12) * 30}ms` } as React.CSSProperties}
    >
      <Link
        href={item.href}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={item.kind === "TRANSFER" ? "truncate font-mono text-sm" : "truncate font-medium"}>
            {item.title}
          </span>
          {item.leavesEstate && (
            <Badge variant="outline" className="shrink-0 gap-1 font-normal">
              <Send className="size-3" aria-hidden="true" />
              {t("leavesEstate")}
            </Badge>
          )}
        </span>
        <span className="line-clamp-2 text-xs leading-5 text-muted-foreground sm:truncate">
          {item.subtitle} · {item.requestedBy ?? t("unknownUser")} · {formatDate(item.createdAt, locale)}
        </span>
        {item.reason && (
          <span className="line-clamp-2 text-xs leading-5 text-destructive" title={item.reason}>
            {item.reason}
          </span>
        )}
      </Link>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-end">
        <KindBadge kind={item.kind} />
        <RequestStatusBadge status={item.status} />
        {actions}
      </div>
    </div>
  )
}
