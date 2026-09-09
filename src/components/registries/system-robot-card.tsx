"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Bot, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

// State of the Harbor system robot Gateway pushes with when a project has no robot of its
// own. The secret is never sent here — only whether one is stored, and when.
export function SystemRobotCard({
  registryId,
  robotName,
  syncedAt,
}: {
  registryId: string
  robotName: string | null
  syncedAt: string | null
}) {
  const t = useTranslations("registries.systemRobot")
  const router = useRouter()
  const [pending, setPending] = React.useState<"sync" | "revoke" | null>(null)

  async function call(method: "POST" | "DELETE", kind: "sync" | "revoke") {
    setPending(kind)
    try {
      const res = await fetch(`/api/registries/${registryId}/system-robot`, { method })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        toast.error(body?.error ?? t("failed"))
        return
      }
      toast.success(kind === "sync" ? t("synced") : t("revoked"))
      router.refresh()
    } catch {
      toast.error(t("failed"))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="mx-4 flex flex-col gap-3 rounded-lg border bg-muted/25 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:mx-6">
      <div className="flex min-w-0 items-start gap-3">
        <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="mt-0.5 break-words text-sm text-muted-foreground">
            {robotName ? (
              <>
                <span className="font-mono">{robotName}</span>
                {syncedAt ? ` · ${t("since", { date: new Date(syncedAt).toLocaleString() })}` : null}
              </>
            ) : (
              t("absent")
            )}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => call("POST", "sync")}
        >
          <RefreshCw />
          {robotName ? t("rotate") : t("provision")}
        </Button>
        {robotName && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={pending !== null}
            onClick={() => call("DELETE", "revoke")}
          >
            {t("revoke")}
          </Button>
        )}
      </div>
    </section>
  )
}
