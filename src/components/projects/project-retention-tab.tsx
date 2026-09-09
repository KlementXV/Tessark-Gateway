"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ProjectRetentionTab({
  projectId,
  retention,
  isManager,
  isActive,
}: {
  projectId: string
  retention: { keepLastN: number; tagPattern: string } | null
  isManager: boolean
  isActive: boolean
}) {
  const t = useTranslations("projects.retention")
  const tc = useTranslations("common")
  const router = useRouter()
  const [keepLastN, setKeepLastN] = React.useState(retention?.keepLastN ?? 10)
  const [tagPattern, setTagPattern] = React.useState(retention?.tagPattern ?? "**")
  const [submitting, setSubmitting] = React.useState(false)
  const [reviewing, setReviewing] = React.useState(false)
  const valid = Number.isInteger(keepLastN) && keepLastN >= 1 && keepLastN <= 1000 && tagPattern.trim().length > 0
  const dirty = keepLastN !== (retention?.keepLastN ?? 10) || tagPattern !== (retention?.tagPattern ?? "**")
  useUnsavedChanges(dirty && !submitting)

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/retention`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepLastN, tagPattern }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("updateFailed")))
        return
      }

      toast.success(t("saved"))
      setReviewing(false)
      router.refresh()
    } catch {
      toast.error(t("updateFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  if (!isActive) {
    return (
      <div className="rounded-lg border border-dashed px-5 py-14 text-center text-sm text-muted-foreground">
        {t("inactive")}
      </div>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) setReviewing(true)
      }}
      className="flex max-w-xl flex-col gap-5"
    >
      <div className="rounded-lg border bg-muted/25 px-4 py-3">
        <p className="text-sm font-medium">{t("howTitle")}</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("howDescription")}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="keepLastN">{t("keepLastN")}</Label>
        <Input
          id="keepLastN"
          type="number"
          min={1}
          max={1000}
          required
          disabled={!isManager}
          value={keepLastN}
          onChange={(e) => setKeepLastN(Number(e.target.value))}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="tagPattern">{t("tagPattern")}</Label>
        <Input
          id="tagPattern"
          disabled={!isManager}
          value={tagPattern}
          onChange={(e) => setTagPattern(e.target.value)}
          placeholder={t("patternPlaceholder")}
          required
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {t.rich("patternHint", {
            code: (chunks) => <code className="rounded bg-muted px-1 py-0.5">{chunks}</code>,
          })}
        </p>
      </div>
      <div className="rounded-lg border px-4 py-3 text-sm" aria-live="polite">
        <span className="text-muted-foreground">{t("previewLabel")}</span>
        {t.rich("preview", {
          n: Number.isFinite(keepLastN) ? String(keepLastN) : "—",
          pattern: tagPattern || "—",
          strong: (chunks) => <strong>{chunks}</strong>,
          code: (chunks) => <code className="rounded bg-muted px-1.5 py-0.5">{chunks}</code>,
        })}
      </div>
      {isManager && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button type="submit" disabled={submitting || !valid || !dirty} className="w-full sm:w-fit">
            {submitting ? tc("saving") : dirty ? t("reviewPolicy") : t("upToDate")}
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">{t("unsavedChanges")}</span>}
        </div>
      )}

      <AlertDialog open={reviewing} onOpenChange={setReviewing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDescription", { n: keepLastN, pattern: tagPattern })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("goBack")}</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={() => void handleSubmit()}>
              {submitting ? tc("saving") : t("savePolicy")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}
