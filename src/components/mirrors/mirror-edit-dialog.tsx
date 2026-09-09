"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { nextRunAt, SCHEDULE_PRESETS } from "@/lib/mirrors/cron"
import type { MirrorWithRuns } from "@/lib/mirrors/view"

/**
 * Editing a mirror: its schedule, the tag it follows, and its description.
 *
 * Not its source or its destination — mirrorUpdateInputSchema refuses those on purpose, since
 * changing either makes it a different mirror while leaving the old CronJob or replication
 * policy installed under a name that no longer means what it says. The form offers what the
 * API accepts rather than showing fields that would be rejected, or worse, silently ignored.
 *
 * Saving re-applies the mirror to its transport (updateMirror ends in applyMirror), so a
 * schedule typed here is armed by the time the dialog closes — or the row comes back
 * `applied: false` carrying the reason, which the board already renders.
 */
export function MirrorEditDialog({ mirror }: { mirror: MirrorWithRuns }) {
  const t = useTranslations("mirrors")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  const [schedule, setSchedule] = React.useState(mirror.schedule)
  const [tag, setTag] = React.useState("")
  const [description, setDescription] = React.useState(mirror.description ?? "")

  // Reopening must not show the previous edit — reset on the way in rather than from an
  // effect watching `open`, which would be a render-time write for something that is really
  // just what happens when the button is pressed.
  function onOpenChange(next: boolean) {
    if (next) {
      setSchedule(mirror.schedule)
      setDescription(mirror.description ?? "")
      // The tag is not carried on PublicMirror as a field of its own; left empty it is simply
      // not sent, and the stored one is kept.
      setTag("")
    }
    setOpen(next)
  }

  // The same evaluator the board's countdown uses, run as you type: a crontab is not a thing
  // most people read back correctly, and "next run in 15 hours" catches a wrong field before
  // it becomes a mirror that quietly never fires.
  const preview = React.useMemo(() => nextRunAt(schedule), [schedule])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(`/api/mirrors/${mirror.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule,
          description: description.trim() || null,
          ...(tag.trim() ? { tag: tag.trim() } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("updateFailed")))
        return
      }
      toast.success(t("updated"))
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("updateFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t("editAria", { name: mirror.name })}>
              <Pencil />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t("editHint")}</TooltipContent>
      </Tooltip>

      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("editTitle", { name: mirror.name })}</DialogTitle>
            <DialogDescription>{t("editDescription")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-edit-schedule">{t("schedule")}</Label>
            <Input
              id="mirror-edit-schedule"
              required
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
              className="font-mono text-sm"
            />
            <div className="flex flex-wrap gap-1">
              {SCHEDULE_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 font-mono text-xs text-muted-foreground"
                  onClick={() => setSchedule(preset)}
                >
                  {preset}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {preview
                ? t("schedulePreview", { at: preview.toISOString().slice(0, 16).replace("T", " ") })
                : t("scheduleInvalid")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-edit-tag">{t("editTag")}</Label>
            <Input
              id="mirror-edit-tag"
              value={tag}
              placeholder={t("editTagPlaceholder")}
              onChange={(event) => setTag(event.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("editTagHint")}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-edit-description">{t("editDescriptionField")}</Label>
            <Input
              id="mirror-edit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            {t("editImmutableHint")}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !preview}>
              {submitting ? tc("saving") : tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
