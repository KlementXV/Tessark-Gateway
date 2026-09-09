"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, LoaderCircle, Save, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { extractErrorMessage } from "@/lib/api-error"
import { isValidRetentionDays, MAX_RETENTION_DAYS } from "@/lib/history/window"

interface PurgeResult {
  transfers: number
  quotaRequests: number
  deleteRequests: number
  notifications: number
}

export function HistoryForm({ retentionDays }: { retentionDays: number }) {
  const t = useTranslations("settings.history")
  const tc = useTranslations("common")
  const router = useRouter()
  const [value, setValue] = React.useState(String(retentionDays))
  const [submitting, setSubmitting] = React.useState(false)

  const parsed = Number(value)
  const invalid = value.trim() === "" || !isValidRetentionDays(parsed)
  const dirty = value !== String(retentionDays)
  useUnsavedChanges(dirty && !submitting)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (invalid) return
    setSubmitting(true)

    try {
      const res = await fetch("/api/settings/history", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyRetentionDays: parsed }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("updateFailed")))
        return
      }

      // The save applies the new window straight away, so the toast reports what it actually
      // removed. Saying "saved" alone would leave the admin guessing whether it had any effect.
      const body = (await res.json()) as { purged: PurgeResult }
      const removed =
        body.purged.transfers +
        body.purged.quotaRequests +
        body.purged.deleteRequests +
        body.purged.notifications
      if (removed > 0) {
        toast.success(t("updatedPurged", { count: removed }))
      } else {
        toast.success(t("updated"))
      }
      router.refresh()
    } catch {
      toast.error(t("updateFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="animate-enter overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)]"
    >
      <header className="flex items-start gap-3 px-6 pt-6 pb-0 sm:px-8 sm:pt-8">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
          <Trash2 className="size-4" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{t("windowTitle")}</h3>
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{t("windowHint")}</p>
        </div>
      </header>

      <div className="flex flex-col gap-2 px-6 pt-6 pb-8 sm:max-w-xs sm:px-8 sm:pt-7 sm:pb-9">
        <Label htmlFor="historyRetentionDays">{t("days")}</Label>
        <Input
          id="historyRetentionDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_RETENTION_DAYS}
          step={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="h-10"
        />
        {invalid ? (
          <p className="text-xs leading-5 text-destructive">{t("invalidDays")}</p>
        ) : parsed === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">{t("disabledHint")}</p>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">{t("daysHint", { days: parsed })}</p>
        )}
      </div>

      {/* What is never touched, said next to the control that does the touching rather than in
          a paragraph elsewhere: an admin setting 7 days needs to know a month-old pending
          request survives it. */}
      <div className="border-t bg-muted/20 px-6 py-5 sm:px-8 sm:py-6">
        <p className="text-xs leading-5 text-muted-foreground">{t("scopeHint")}</p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5 px-1">
            <span
              className={`size-2 rounded-full ${dirty ? "bg-warning" : "bg-success"}`}
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-muted-foreground">
              {dirty ? t("unsavedChanges") : t("allSaved")}
            </span>
          </div>
          <Button
            type="submit"
            disabled={submitting || !dirty || invalid}
            className="w-full min-w-36 sm:w-auto"
          >
            {submitting ? <LoaderCircle className="animate-spin" /> : dirty ? <Save /> : <Check />}
            {submitting ? tc("saving") : dirty ? t("saveChanges") : t("saved")}
          </Button>
        </div>
      </div>
    </form>
  )
}
