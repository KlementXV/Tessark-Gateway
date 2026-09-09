"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronDown, Layers, X } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { extractErrorMessage } from "@/lib/api-error"
import { formatDate } from "@/lib/format-date"
import type { RequestItem } from "@/lib/requests/service"
import { RequestRow, RequestsEmptyState } from "@/components/requests/request-row"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// Each kind reviews through its own endpoint, which already enforces ADMIN and the
// pending-state check — this list only routes to the right one.
const REVIEW_BASE = {
  PROJECT: "/api/projects",
  TRANSFER: "/api/transfers",
  QUOTA: "/api/quota-requests",
  PROJECT_DELETE: "/api/project-delete-requests",
} as const

function endpoint(item: RequestItem, action: "approve" | "reject") {
  return `${REVIEW_BASE[item.kind]}/${item.id}/${action}`
}

/**
 * One line of the queue: a request on its own, or the several a requester submitted in one
 * paste.
 *
 * A batch is a way of *reading* the queue, never a new unit of decision — the rows underneath
 * keep their own approval, status and retry. Which is exactly why the group offers a selection
 * rather than one verdict: a list of fourteen images commonly holds twelve a reviewer is happy
 * with and two they are not, and the only alternatives without this are approving all fourteen
 * or working through them one at a time.
 */
type QueueRow =
  | { kind: "single"; key: string; item: RequestItem }
  | { kind: "batch"; key: string; items: RequestItem[] }

function groupRows(items: RequestItem[]): QueueRow[] {
  const rows: QueueRow[] = []
  const batchIndex = new Map<string, number>()

  for (const item of items) {
    // Only transfers are ever batched, and a batch of one is a single request wearing a
    // heading: it is shown as the row it is.
    const batchId = item.kind === "TRANSFER" ? item.batchId : null
    if (!batchId) {
      rows.push({ kind: "single", key: `${item.kind}-${item.id}`, item })
      continue
    }
    const existing = batchIndex.get(batchId)
    if (existing === undefined) {
      batchIndex.set(batchId, rows.length)
      rows.push({ kind: "batch", key: `batch-${batchId}`, items: [item] })
      continue
    }
    ;(rows[existing] as { items: RequestItem[] }).items.push(item)
  }

  return rows.map((row) =>
    row.kind === "batch" && row.items.length === 1
      ? { kind: "single", key: `${row.items[0].kind}-${row.items[0].id}`, item: row.items[0] }
      : row,
  )
}

export function PendingRequestsList({ requests }: { requests: RequestItem[] }) {
  const t = useTranslations("requests.pending")
  const tc = useTranslations("common")
  const router = useRouter()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [approving, setApproving] = React.useState<RequestItem | null>(null)
  const [rejecting, setRejecting] = React.useState<RequestItem | null>(null)
  // A review of several rows at once: which ones, and which verdict is being confirmed.
  const [bulk, setBulk] = React.useState<{ action: "approve" | "reject"; items: RequestItem[] } | null>(
    null,
  )
  const [running, setRunning] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState("")
  const normalizedQuery = query.trim().toLowerCase()
  const visibleRequests = requests.filter(
    (item) =>
      !normalizedQuery ||
      item.title.toLowerCase().includes(normalizedQuery) ||
      (item.requestedBy ?? "").toLowerCase().includes(normalizedQuery) ||
      item.kind.toLowerCase().includes(normalizedQuery),
  )
  // Grouped after filtering, so a search inside a batch narrows the group rather than hiding it.
  const blocks = React.useMemo(() => {
    const rows = groupRows(visibleRequests)
    // Runs of ungrouped requests are drawn as the one list they used to be: a border per row
    // would turn the ordinary queue into a stack of cards to pay for a batch that isn't there.
    const out: ({ kind: "singles"; key: string; items: RequestItem[] } | Extract<QueueRow, { kind: "batch" }>)[] = []
    for (const row of rows) {
      if (row.kind === "batch") {
        out.push(row)
        continue
      }
      const last = out[out.length - 1]
      if (last?.kind === "singles") last.items.push(row.item)
      else out.push({ kind: "singles", key: `singles-${row.key}`, items: [row.item] })
    }
    return out
  }, [visibleRequests])

  function toggleSelection(ids: string[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function handleApprove(item: RequestItem) {
    setPendingId(item.id)
    try {
      const res = await fetch(endpoint(item, "approve"), { method: "POST" })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("approveFailed")))
        return
      }

      toast.success(
        item.kind === "PROJECT"
          ? t("projectApproved")
          : item.kind === "QUOTA"
            ? t("quotaApplied")
            : item.kind === "PROJECT_DELETE"
              ? t("projectDeleted", { project: item.title })
              : t("mirrorStarted"),
      )
      setApproving(null)
      router.refresh()
    } catch {
      toast.error(t("approveFailed"))
    } finally {
      setPendingId(null)
    }
  }

  async function handleReject() {
    if (!rejecting) return
    setPendingId(rejecting.id)
    try {
      const res = await fetch(endpoint(rejecting, "reject"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("rejectFailed")))
        return
      }

      toast.success(t("rejected"))
      setRejecting(null)
      setReason("")
      router.refresh()
    } catch {
      toast.error(t("rejectFailed"))
    } finally {
      setPendingId(null)
    }
  }

  /**
   * The selected rows, reviewed one after the other.
   *
   * Sequential rather than parallel: approving a transfer starts Kubernetes Jobs, and firing
   * fourteen of those at once is a different load on the cluster than the reviewer meant to
   * cause. Each row keeps its own outcome — a launch that fails leaves that request pending and
   * says so, without taking the others down — so the report at the end is per image, never a
   * single verdict for the group.
   */
  async function runBulk(items: RequestItem[], action: "approve" | "reject", rejectReason: string) {
    setRunning(true)
    const failures: { title: string; error: string }[] = []
    let done = 0
    try {
      for (const item of items) {
        try {
          const res = await fetch(endpoint(item, action), {
            method: "POST",
            ...(action === "reject"
              ? {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reason: rejectReason }),
                }
              : {}),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => null)
            failures.push({
              title: item.title,
              error: extractErrorMessage(body, action === "approve" ? t("approveFailed") : t("rejectFailed")),
            })
            continue
          }
          done += 1
        } catch {
          failures.push({
            title: item.title,
            error: action === "approve" ? t("approveFailed") : t("rejectFailed"),
          })
        }
      }

      if (failures.length > 0) {
        // Partial outcomes are said out loud, image by image: a toast claiming the batch went
        // through while two rows were refused is how a reviewer finds out days later.
        toast.warning(t("batchPartial", { done, failed: failures.length }), {
          description: failures.map((entry) => `${entry.title} — ${entry.error}`).join("\n"),
        })
      } else {
        toast.success(
          action === "approve" ? t("batchApproved", { count: done }) : t("batchRejected", { count: done }),
        )
      }

      setSelected((current) => {
        const next = new Set(current)
        for (const item of items) next.delete(item.id)
        return next
      })
      setBulk(null)
      setReason("")
      router.refresh()
    } finally {
      setRunning(false)
    }
  }

  if (requests.length === 0) {
    return <RequestsEmptyState title={t("emptyTitle")} hint={t("emptyHint")} />
  }

  const rowActions = (item: RequestItem) => (
    <>
      <Button size="sm" variant="outline" disabled={pendingId === item.id} onClick={() => setApproving(item)}>
        <Check />
        {t("approve")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        disabled={pendingId === item.id}
        onClick={() => setRejecting(item)}
      >
        <X />
        {t("reject")}
      </Button>
    </>
  )

  return (
    <>
      <div className="mx-4 mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:mx-6">
        <SearchInput
            id="request-search"
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="sm:max-w-sm"
          />
        <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {t("countPending", { visible: visibleRequests.length, total: requests.length })}
        </p>
      </div>

      {visibleRequests.length === 0 ? (
        <div className="mx-4 rounded-lg border border-dashed px-5 py-12 text-center lg:mx-6">
          <p className="text-sm font-medium">{t("noMatch", { query: query.trim() })}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setQuery("")}>
            <X />
            {t("clearSearch")}
          </Button>
        </div>
      ) : (
      <div className="mx-4 flex flex-col gap-3 lg:mx-6">
        {/* Requests on their own keep the single bordered list they have always been; only a
            batch gets a box of its own, because it is the one thing that has a heading. */}
        {blocks.map((block, index) =>
          block.kind === "singles" ? (
            <div key={block.key} className="divide-y overflow-hidden rounded-lg border">
              {block.items.map((item, i) => (
                <RequestRow
                  key={`${item.kind}-${item.id}`}
                  item={item}
                  index={index + i}
                  actions={rowActions(item)}
                />
              ))}
            </div>
          ) : (
            <BatchCard
              key={block.key}
              items={block.items}
              index={index}
              selected={selected}
              busy={running}
              onToggle={toggleSelection}
              onReview={(items, action) => {
                setReason("")
                setBulk({ action, items })
              }}
            />
          ),
        )}
      </div>
      )}

      <Dialog open={Boolean(approving)} onOpenChange={(open) => !open && setApproving(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("approveTitle", { title: approving?.title ?? "" })}</DialogTitle>
            <DialogDescription>
              {approving?.kind === "PROJECT"
                ? t("approveProject")
                : approving?.kind === "QUOTA"
                  ? t("approveQuota", { change: approving.subtitle })
                  : approving?.kind === "PROJECT_DELETE"
                    ? t("approveProjectDelete", { project: approving.title })
                    : t("approvePull")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproving(null)}>
              {tc("cancel")}
            </Button>
            <Button
              variant={approving?.kind === "PROJECT_DELETE" ? "destructive" : "default"}
              disabled={!approving || pendingId === approving.id}
              onClick={() => approving && void handleApprove(approving)}
            >
              <Check />
              {pendingId === approving?.id ? t("approving") : t("approveSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rejecting)}
        onOpenChange={(open) => {
          if (!open) {
            setRejecting(null)
            setReason("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("rejectTitle", { title: rejecting?.title ?? "" })}</DialogTitle>
            <DialogDescription>{t("rejectDescription")}</DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("reasonPlaceholder")} />
          <DialogFooter>
            <Button variant="destructive" disabled={!reason || pendingId === rejecting?.id} onClick={handleReject}>
              {pendingId === rejecting?.id ? t("rejecting") : t("rejectSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(bulk)}
        onOpenChange={(open) => {
          if (!open && !running) {
            setBulk(null)
            setReason("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {bulk?.action === "approve"
                ? t("batchApproveTitle", { count: bulk?.items.length ?? 0 })
                : t("batchRejectTitle", { count: bulk?.items.length ?? 0 })}
            </DialogTitle>
            <DialogDescription>
              {bulk?.action === "approve" ? t("batchApproveDescription") : t("rejectDescription")}
            </DialogDescription>
          </DialogHeader>
          {/* The images about to be reviewed, in full: the selection was made in a list that
              scrolls, and a verdict on fourteen rows deserves to name them. */}
          <ul className="max-h-40 overflow-y-auto rounded-md border px-3 py-2 font-mono text-xs text-muted-foreground">
            {bulk?.items.map((item) => (
              <li key={item.id} className="truncate">
                {item.title}
              </li>
            ))}
          </ul>
          {bulk?.action === "reject" && (
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
            />
          )}
          <DialogFooter>
            <Button
              variant={bulk?.action === "reject" ? "destructive" : "default"}
              disabled={running || !bulk || (bulk.action === "reject" && !reason)}
              onClick={() => bulk && void runBulk(bulk.items, bulk.action, reason)}
            >
              {running
                ? bulk?.action === "approve"
                  ? t("approving")
                  : t("rejecting")
                : bulk?.action === "approve"
                  ? t("approveSubmit")
                  : t("rejectSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The several images one requester asked for in one gesture, with a checkbox per row.
 *
 * The header's own checkbox is a three-state one on purpose: "some of these" is the state a
 * partial review is in most of the time, and a box that could only say yes or no would have to
 * lie about it.
 */
function BatchCard({
  items,
  index,
  selected,
  busy,
  onToggle,
  onReview,
}: {
  items: RequestItem[]
  index: number
  selected: Set<string>
  busy: boolean
  onToggle: (ids: string[], checked: boolean) => void
  onReview: (items: RequestItem[], action: "approve" | "reject") => void
}) {
  const t = useTranslations("requests.pending")
  const locale = useLocale()
  // A long list starts folded: the queue has to stay readable as a queue, and the count plus
  // the requester is what decides whether this group is worth opening at all.
  const [open, setOpen] = React.useState(items.length <= 8)

  const ids = items.map((item) => item.id)
  const chosen = items.filter((item) => selected.has(item.id))
  const allSelected = chosen.length === items.length
  const headerState = allSelected ? true : chosen.length > 0 ? "indeterminate" : false

  return (
    <div
      className="animate-enter overflow-hidden rounded-lg border"
      style={{ "--enter-delay": `${Math.min(index, 12) * 30}ms` } as React.CSSProperties}
    >
      <div className="flex flex-col gap-3 bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Checkbox
            checked={headerState}
            onCheckedChange={(value) => onToggle(ids, value === true)}
            aria-label={t("batchSelectAll")}
          />
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="flex min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
          >
            <ChevronDown className={cn("size-4 shrink-0 transition-transform", !open && "-rotate-90")} />
            <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {t("batchTitle", { count: items.length })}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {items[0].requestedBy ?? t("unknownRequester")} ·{" "}
                {formatDate(items[0].createdAt, locale)}
              </span>
            </span>
          </button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("batchSelected", { count: chosen.length, total: items.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || chosen.length === 0}
            onClick={() => onReview(chosen, "approve")}
          >
            <Check />
            {t("approveSelection")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={busy || chosen.length === 0}
            onClick={() => onReview(chosen, "reject")}
          >
            <X />
            {t("rejectSelection")}
          </Button>
        </div>
      </div>

      {open && (
        <div className="divide-y">
          {items.map((item, i) => (
            <div key={item.id} className="flex items-start gap-3 pl-4">
              <Checkbox
                className="mt-4"
                checked={selected.has(item.id)}
                onCheckedChange={(value) => onToggle([item.id], value === true)}
                aria-label={t("batchSelectOne", { image: item.title })}
              />
              <div className="min-w-0 flex-1">
                <RequestRow item={item} index={i} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
