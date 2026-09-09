"use client"

import * as React from "react"
import { X } from "lucide-react"
import { useTranslations } from "next-intl"

import { useTransferSync } from "@/hooks/use-live-refresh"
import { SearchInput } from "@/components/ui/search-input"
import type { RequestItem } from "@/lib/requests/service"
import { RequestRow, RequestsEmptyState, useRequestStatusLabel } from "@/components/requests/request-row"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// Used by both surfaces that report on requests rather than act on them: the admin history
// and a user's own requests.
export function RequestsReadOnlyList({
  requests,
  emptyTitle,
  emptyHint,
}: {
  requests: RequestItem[]
  emptyTitle: string
  emptyHint: string
}) {
  const t = useTranslations("requests.list")
  const statusLabel = useRequestStatusLabel()
  const [query, setQuery] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState("all")

  // A transfer job only reports back through the sync endpoint, so an approved one is polled
  // until it settles — same handling as the project's own transfers tab.
  useTransferSync(
    requests.filter((item) => item.kind === "TRANSFER" && item.status === "RUNNING").map((item) => item.id),
  )

  if (requests.length === 0) {
    return <RequestsEmptyState title={emptyTitle} hint={emptyHint} />
  }

  const normalizedQuery = query.trim().toLowerCase()
  const statuses = [...new Set(requests.map((item) => item.status))]
  const visibleRequests = requests.filter(
    (item) =>
      (statusFilter === "all" || item.status === statusFilter) &&
      (!normalizedQuery ||
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.subtitle.toLowerCase().includes(normalizedQuery) ||
        (item.requestedBy ?? "").toLowerCase().includes(normalizedQuery)),
  )

  return (
    <>
      <div className="mx-4 mb-4 flex flex-col gap-3 sm:flex-row sm:items-end lg:mx-6">
        <SearchInput
            id="history-request-search"
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="sm:max-w-sm"
          />
        <div className="flex w-full flex-col gap-1.5 sm:w-44">
          <Label htmlFor="request-status" className="text-xs text-muted-foreground">
            {t("status")}
          </Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="request-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allStatuses")}</SelectItem>
              {statuses.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="pb-2 text-xs tabular-nums text-muted-foreground sm:ml-auto" aria-live="polite">
          {t("count", { visible: visibleRequests.length, total: requests.length })}
        </p>
      </div>

      {visibleRequests.length === 0 ? (
        <div className="mx-4 rounded-lg border border-dashed px-5 py-12 text-center lg:mx-6">
          <p className="text-sm font-medium">{t("noMatch")}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => {
              setQuery("")
              setStatusFilter("all")
            }}
          >
            <X />
            {t("clearFilters")}
          </Button>
        </div>
      ) : (
        <div className="mx-4 divide-y overflow-hidden rounded-lg border lg:mx-6">
          {visibleRequests.map((item, i) => (
            <RequestRow key={`${item.kind}-${item.id}`} item={item} index={i} />
          ))}
        </div>
      )}
    </>
  )
}
