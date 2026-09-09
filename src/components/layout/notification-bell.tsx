"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Bell, CheckCheck } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import { formatDateTime } from "@/lib/format-date"
import type { NotificationItem } from "@/lib/notifications/service"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"

// The header renders the unread count server-side so the badge is right on first paint; the
// list itself is only fetched when the bell is opened, since most page loads never open it.
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const t = useTranslations("notifications")
  const locale = useLocale()
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [unread, setUnread] = React.useState(initialUnread)
  const [items, setItems] = React.useState<NotificationItem[] | null>(null)

  // The server-rendered count becomes the source of truth again whenever it changes — any
  // router.refresh() (approving from the queue, say) re-renders the header with a fresh one,
  // and it must win over the optimistic decrements below. Adjusted during render rather than
  // in an effect: React re-renders immediately with the new value instead of painting the
  // stale one first.
  const [lastServerUnread, setLastServerUnread] = React.useState(initialUnread)
  if (lastServerUnread !== initialUnread) {
    setLastServerUnread(initialUnread)
    setUnread(initialUnread)
  }

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/notifications")
      if (!res.ok) return
      const body = (await res.json()) as { items: NotificationItem[]; unread: number }
      setItems(body.items)
      setUnread(body.unread)
    } catch {
      // A bell that fails to load is a non-event: the empty state is honest enough, and
      // there is nothing the reader could do about it anyway.
      setItems([])
    }
  }, [])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) void load()
  }

  async function markAll() {
    setUnread(0)
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? null)
    await fetch("/api/notifications/read", { method: "POST" }).catch(() => {})
    router.refresh()
  }

  async function openItem(item: NotificationItem) {
    setOpen(false)
    if (!item.read) {
      setUnread((n) => Math.max(0, n - 1))
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      }).catch(() => {})
    }
    if (item.href) router.push(item.href)
    else router.refresh()
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? t("openWithCount", { count: unread }) : t("open")}
        >
          <Bell />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-4 tabular-nums text-white"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <p className="text-sm font-medium">{t("title")}</p>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void markAll()}>
              <CheckCheck className="size-3.5" />
              {t("markAllRead")}
            </Button>
          )}
        </div>

        {items === null ? (
          <div className="flex flex-col gap-2 p-4" aria-label={t("loading")}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void openItem(item)}
                    className="flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:bg-muted/60"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        item.read
                          ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-transparent"
                          : "mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className={item.read ? "block text-sm" : "block text-sm font-medium"}>
                        <NotificationMessage item={item} />
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {formatDateTime(item.createdAt, locale)}
                      </span>
                    </span>
                    {!item.read && <span className="sr-only">{t("unread")}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}

// The sentence is assembled here, in the reader's own language, from the kind and the values
// stored with the row — never from a sentence frozen at write time in the actor's locale.
function NotificationMessage({ item }: { item: NotificationItem }) {
  const t = useTranslations("notifications.kind")
  // A kind this build doesn't know (a row written by a newer version during a rolling
  // upgrade) falls back to its own name rather than throwing the whole list away.
  const known = t.has(item.kind)
  return <>{known ? t(item.kind, item.payload) : item.kind}</>
}
