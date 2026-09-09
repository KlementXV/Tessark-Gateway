import {
  ProjectDeleteRequestStatus,
  QuotaRequestStatus,
  TransferStatus,
} from "@/generated/prisma/client"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { DEFAULT_RETENTION_DAYS } from "./window"

// Requests are the one thing this application accumulates without bound. Everything else it
// shows is read live — the image catalogue from Harbor, the activity feed from Kubernetes and
// Harbor, both of which expire on their own — but a transfer approved last year keeps its row,
// its targets, and the record of who asked for what, forever and for nobody.
//
// So: a retention window, set by the operator, applied to the settled rows only.
//
// "Settled" is the load-bearing word. A PENDING transfer is a queue item, not history: purging
// one would answer a request nobody ever reviewed, and the requester would see it vanish rather
// than be refused. RUNNING is the same — a Job may still be moving an image. Age is not what
// makes a row disposable; being finished is, and age only says when.

const SETTINGS_ID = "default"

/** Terminal states. Anything else is still somebody's open question. */
const SETTLED_TRANSFERS: TransferStatus[] = [
  TransferStatus.SUCCEEDED,
  TransferStatus.FAILED,
  TransferStatus.REJECTED,
]

const SETTLED_QUOTAS: QuotaRequestStatus[] = [
  QuotaRequestStatus.APPROVED,
  QuotaRequestStatus.REJECTED,
]

// A settled deletion request is the record of a decision whose subject is often already gone —
// the project it named was destroyed by the approval. That record is exactly what the window is
// for: worth keeping while anyone might ask "who deleted team-app, and why", and nothing more
// than clutter a year later.
const SETTLED_DELETIONS: ProjectDeleteRequestStatus[] = [
  ProjectDeleteRequestStatus.APPROVED,
  ProjectDeleteRequestStatus.REJECTED,
]


export interface PurgeSummary {
  transfers: number
  quotaRequests: number
  deleteRequests: number
  notifications: number
  /** The window that was applied, in days. 0 means the purge is off and nothing was read. */
  retentionDays: number
}

export async function getHistoryRetentionDays(): Promise<number> {
  const settings = await prisma.instanceSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { historyRetentionDays: true },
  })
  return settings?.historyRetentionDays ?? DEFAULT_RETENTION_DAYS
}

export async function setHistoryRetentionDays(days: number): Promise<number> {
  const settings = await prisma.instanceSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, historyRetentionDays: days },
    update: { historyRetentionDays: days },
    select: { historyRetentionDays: true },
  })
  return settings.historyRetentionDays
}

/**
 * Drops settled history older than the configured window.
 *
 * `TransferTarget` goes with its request by cascade, which is what makes this one delete rather
 * than two. Notifications are dropped read or unread: one that has sat unopened past the window
 * is not going to be opened, and keeping it would make the bell the place history hides.
 */
export async function purgeHistory(): Promise<PurgeSummary> {
  const retentionDays = await getHistoryRetentionDays()
  if (retentionDays <= 0) {
    return { transfers: 0, quotaRequests: 0, deleteRequests: 0, notifications: 0, retentionDays: 0 }
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

  // Keyed on updatedAt, not createdAt: a request raised in January and rejected in June was
  // last *relevant* in June, and that is the date the window should count from.
  const transfers = await prisma.transferRequest.deleteMany({
    where: { status: { in: SETTLED_TRANSFERS }, updatedAt: { lt: cutoff } },
  })
  const quotaRequests = await prisma.quotaRequest.deleteMany({
    where: { status: { in: SETTLED_QUOTAS }, updatedAt: { lt: cutoff } },
  })
  const deleteRequests = await prisma.projectDeleteRequest.deleteMany({
    where: { status: { in: SETTLED_DELETIONS }, updatedAt: { lt: cutoff } },
  })
  // Notifications have no settled/unsettled distinction — they are a record of something that
  // already happened, so age is the only criterion that applies.
  const notifications = await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })

  const summary = {
    transfers: transfers.count,
    quotaRequests: quotaRequests.count,
    deleteRequests: deleteRequests.count,
    notifications: notifications.count,
    retentionDays,
  }

  if (summary.transfers + summary.quotaRequests + summary.deleteRequests + summary.notifications > 0) {
    logger.info("History purged", summary)
  }
  return summary
}

// There is no scheduler in this application — the same reason reconcileRegistriesInBackground
// exists. The purge therefore rides on page loads, throttled so that a busy instance runs it
// about once an hour rather than on every render, and a quiet one runs it the next time anyone
// looks. The consequence is honest and worth stating: the window is "at least N days", never
// "exactly N days", because nothing deletes a row while nobody is using the app.
const PURGE_INTERVAL_MS = 60 * 60 * 1000
let lastPurgeAt = 0
let inFlight: Promise<PurgeSummary> | null = null

export function purgeHistoryInBackground(): void {
  const now = Date.now()
  if (inFlight || now - lastPurgeAt < PURGE_INTERVAL_MS) return
  lastPurgeAt = now

  // Nothing awaits this, so an escaping rejection would be an unhandled one and Node ends the
  // process on those. A page that merely listed requests must never be able to take the pod
  // down, so the whole body is guarded.
  inFlight = purgeHistory()
    .catch((err) => {
      logger.warn("History purge failed", { error: err instanceof Error ? err.message : String(err) })
      // Retried on the next interval; nothing here is urgent enough to loop on.
      return { transfers: 0, quotaRequests: 0, deleteRequests: 0, notifications: 0, retentionDays: 0 }
    })
    .finally(() => {
      inFlight = null
    })
}
