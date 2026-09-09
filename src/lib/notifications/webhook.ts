// Outgoing delivery to a Slack/Teams/generic endpoint. Off unless NOTIFICATIONS_WEBHOOK_URL
// is set — an operator who never sets it pays nothing, and no request leaves the pod.
import type { NotificationKind } from "@/generated/prisma/client"

import { getConfig } from "@/lib/config"
import { logger } from "@/lib/logger"
import { webhookText } from "@/lib/notifications/events"

export interface WebhookPayload {
  kind: NotificationKind
  actor: string
  payload: Record<string, string>
  href: string
  recipients: number
}

function body(format: "json" | "slack" | "teams", event: WebhookPayload, text: string) {
  switch (format) {
    case "slack":
      return { text }
    case "teams":
      // Legacy MessageCard rather than an Adaptive Card: it is what an Incoming Webhook
      // connector accepts without a Power Automate flow in front of it.
      return {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: text,
        text,
      }
    default:
      return { ...event, text, at: new Date().toISOString() }
  }
}

/**
 * Posts one event. Never throws and never retries: a notification is a side effect of an
 * action that has already succeeded, so a webhook being down must not turn an approval into
 * a 500 — the in-app row is the durable record, this is the courtesy copy. Failures are
 * logged at warn and dropped.
 *
 * Awaited by the caller rather than fired and forgotten, which is why the timeout is short:
 * an unreachable endpoint delays the response by at most NOTIFICATIONS_WEBHOOK_TIMEOUT_MS,
 * and an unhandled rejection can never escape into the process.
 */
export async function postWebhook(event: WebhookPayload): Promise<void> {
  const config = getConfig()
  const url = config.notificationsWebhookUrl
  if (!url) return

  const text = webhookText(event.kind, { ...event.payload, actor: event.actor })

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(config.notificationsWebhookFormat, event, text)),
      signal: AbortSignal.timeout(config.notificationsWebhookTimeoutMs),
    })
    if (!res.ok) {
      // The endpoint URL frequently *is* the credential (a Slack webhook URL is unguessable
      // by design), so it is never logged — only the status it answered with.
      logger.warn("notification webhook rejected", { kind: event.kind, status: res.status })
    }
  } catch (err) {
    logger.warn("notification webhook failed", {
      kind: event.kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
