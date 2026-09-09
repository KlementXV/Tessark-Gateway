// The notification centre: writing events, and reading them back for the header bell.
//
// Scope, deliberately: only events a user triggers produce a notification, because nothing in
// this app runs without an inbound HTTP request — no CronJob, no worker, no Kubernetes watch.
// A skopeo Job finishing or a Harbor draining its PendingOperation queue therefore has no
// moment at which a row could be written; notifying those means introducing a scheduler
// first, which is a separate piece of work.
import { Role } from "@/generated/prisma/client"
import type { NotificationKind } from "@/generated/prisma/client"

import { getConfig } from "@/lib/config"
import { logger } from "@/lib/logger"
import type { NotificationEvent } from "@/lib/notifications/events"
import { postWebhook } from "@/lib/notifications/webhook"
import { prisma } from "@/lib/prisma"

/** How many the bell ever shows — it is a recent-activity list, not an archive. */
export const NOTIFICATION_PAGE_SIZE = 30

async function resolveRecipients(event: NotificationEvent): Promise<string[]> {
  const ids =
    "admins" in event.audience
      ? (
          await prisma.user.findMany({
            where: { role: { in: [Role.ADMIN, Role.SUPERADMIN] }, disabled: false },
            select: { id: true },
          })
        ).map((user) => user.id)
      : event.audience.userIds

  // Nobody is told about their own action, and a user listed twice gets one row.
  return [...new Set(ids)].filter((id) => id !== event.actorUserId)
}

/**
 * Records an event and hands a copy to the webhook.
 *
 * Never throws: it is called from route handlers *after* the action they perform has already
 * succeeded and been committed, so a failure here must not turn a successful approval into a
 * 500. Anything that goes wrong is logged and swallowed — callers are not expected to catch.
 */
export async function notify(event: NotificationEvent): Promise<void> {
  try {
    const [recipients, actor] = await Promise.all([
      resolveRecipients(event),
      prisma.user.findUnique({
        where: { id: event.actorUserId },
        select: { name: true, username: true },
      }),
    ])

    const actorName = actor?.name?.trim() || actor?.username || "someone"
    // The actor's display name is resolved once, here, and frozen into the payload: a
    // notification says who did the thing at the time it was done, and re-resolving it at
    // read time would need a join per row for a name that rarely changes.
    const payload = { ...event.payload, actor: actorName }

    if (recipients.length > 0) {
      await prisma.notification.createMany({
        data: recipients.map((userId) => ({
          userId,
          kind: event.kind,
          payload: JSON.stringify(payload),
          href: event.href,
        })),
      })
    }

    // Sent even when nobody is notified in-app: a webhook watcher is a channel, not a
    // recipient list, and "the only admin approved their own request" is still worth seeing.
    await postWebhook({
      kind: event.kind,
      actor: actorName,
      payload,
      href: event.href,
      recipients: recipients.length,
    })
  } catch (err) {
    logger.error("failed to emit notification", {
      kind: event.kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export interface NotificationItem {
  id: string
  // The literal union, not a bare string: the bell renders each row through the
  // `notifications.kind.<KIND>` message, and this is what makes next-intl check at compile
  // time that every kind has one in both catalogues.
  kind: NotificationKind
  payload: Record<string, string>
  href: string | null
  read: boolean
  createdAt: string
}

function toItem(row: {
  id: string
  kind: NotificationKind
  payload: string
  href: string | null
  readAt: Date | null
  createdAt: Date
}): NotificationItem {
  let payload: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(row.payload)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, string>
    }
  } catch {
    // A row whose payload can't be parsed still has a kind and a date worth showing; the
    // message renders with empty placeholders rather than taking the whole list down.
  }
  return {
    id: row.id,
    kind: row.kind,
    payload,
    href: row.href,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listNotifications(userId: string): Promise<NotificationItem[]> {
  const rows = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: NOTIFICATION_PAGE_SIZE,
  })
  return rows.map(toItem)
}

export function countUnreadNotifications(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } })
}

/** Scoped by userId as well as id, so an id from another account marks nothing. */
export async function markNotificationRead(userId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  })
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  })

  // Retention runs here rather than on a schedule, for the same reason the whole feature is
  // synchronous: there is nothing to run it. Marking the list read is the natural moment —
  // infrequent, already a write, and scoped to one user's own indexed rows. Unread rows are
  // never swept — a null readAt does not match `lt`, so they are excluded by construction.
  const cutoff = new Date(Date.now() - getConfig().notificationRetentionDays * 86_400_000)
  await prisma.notification.deleteMany({ where: { userId, readAt: { lt: cutoff } } })
}
