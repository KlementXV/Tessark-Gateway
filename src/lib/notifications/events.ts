// The catalogue of things worth telling someone about, and the exact values each one carries.
//
// PayloadMap is the contract that ties three places together: the row written in the
// database, the `notifications.kind.*` message that renders it, and the English sentence the
// webhook sends. Adding a placeholder to a message means adding it here first, so the three
// cannot drift apart silently.
import type { NotificationKind } from "@/generated/prisma/client"

export type PayloadMap = {
  PROJECT_REQUESTED: { project: string; cluster: string }
  PROJECT_APPROVED: { project: string }
  PROJECT_REJECTED: { project: string; reason: string }
  TRANSFER_REQUESTED: { image: string; destinations: string }
  TRANSFER_APPROVED: { image: string }
  TRANSFER_REJECTED: { image: string; reason: string }
  QUOTA_REQUESTED: { project: string; change: string }
  QUOTA_APPROVED: { project: string; quota: string }
  QUOTA_REJECTED: { project: string; reason: string }
  PROJECT_DELETE_REQUESTED: { project: string; reason: string }
  PROJECT_DELETE_APPROVED: { project: string }
  PROJECT_DELETE_REJECTED: { project: string; reason: string }
  MEMBER_ADDED: { project: string; role: string }
}

/**
 * Who receives an event.
 *
 * `admins` is every enabled ADMIN/SUPERADMIN — the review queue's audience. `userIds` names
 * the recipients directly, which is how a decision reaches the person who asked for it.
 * Either way the actor is removed: an admin approving their own request already knows.
 */
export type Audience = { admins: true } | { userIds: string[] }

export type NotificationEvent = {
  [K in NotificationKind]: {
    kind: K
    payload: PayloadMap[K]
    audience: Audience
    /** Where the bell sends the reader — a Gateway path, never an absolute URL. */
    href: string
    /** Excluded from the recipients, and named as `{actor}` in every message. */
    actorUserId: string
  }
}[NotificationKind]

// The message templates the webhook uses. Deliberately English and deliberately separate from
// messages/{en,fr}.json: a webhook body is a machine contract read by Slack, Teams or an
// operator's own pipeline, exactly like the REST and MCP error bodies (CLAUDE.md). The in-app
// centre renders the same event through next-intl instead, in the reader's own language.
const WEBHOOK_TEMPLATES: { [K in NotificationKind]: (p: PayloadMap[K] & { actor: string }) => string } = {
  PROJECT_REQUESTED: (p) => `${p.actor} requested the project ${p.project} on ${p.cluster}.`,
  PROJECT_APPROVED: (p) => `${p.actor} approved the project ${p.project}.`,
  PROJECT_REJECTED: (p) => `${p.actor} rejected the project ${p.project} — ${p.reason}`,
  TRANSFER_REQUESTED: (p) => `${p.actor} requested a mirror of ${p.image} into ${p.destinations}.`,
  TRANSFER_APPROVED: (p) => `${p.actor} approved the mirror of ${p.image}.`,
  TRANSFER_REJECTED: (p) => `${p.actor} rejected the mirror of ${p.image} — ${p.reason}`,
  QUOTA_REQUESTED: (p) => `${p.actor} requested a quota change on ${p.project} (${p.change}).`,
  QUOTA_APPROVED: (p) => `${p.actor} set the quota of ${p.project} to ${p.quota}.`,
  QUOTA_REJECTED: (p) => `${p.actor} rejected the quota change on ${p.project} — ${p.reason}`,
  PROJECT_DELETE_REQUESTED: (p) =>
    `${p.actor} asked for the project ${p.project} to be deleted — ${p.reason}`,
  PROJECT_DELETE_APPROVED: (p) => `${p.actor} deleted the project ${p.project}.`,
  PROJECT_DELETE_REJECTED: (p) =>
    `${p.actor} refused to delete the project ${p.project} — ${p.reason}`,
  MEMBER_ADDED: (p) => `${p.actor} added you to ${p.project} as ${p.role}.`,
}

export function webhookText(
  kind: NotificationKind,
  payload: Record<string, string> & { actor: string },
): string {
  // The cast is safe by construction: `payload` is only ever built from the NotificationEvent
  // whose `kind` this is, and PayloadMap is what enforced that at the call site.
  const template = WEBHOOK_TEMPLATES[kind] as (p: Record<string, string>) => string
  return template(payload)
}
