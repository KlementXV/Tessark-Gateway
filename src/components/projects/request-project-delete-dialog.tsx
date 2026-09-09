"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { extractErrorMessage } from "@/lib/api-error"

/**
 * Asking an admin to take this project down.
 *
 * The counterpart of DeleteProjectButton, for everybody that button is not offered to. A
 * manager deletes; everybody else asks, with a reason — required, because the reviewer is being
 * asked to destroy something and the project itself says nothing about whether it is still
 * needed.
 *
 * Nothing is destroyed here, so there is no name to type: this dialog raises a request, and the
 * confirmation that matters happens in the review queue, where the deletion actually runs.
 */
export function RequestProjectDeleteDialog({
  id,
  name,
  pending = false,
}: {
  id: string
  name: string
  /** A request is already waiting for review — the trigger then says so instead of asking again. */
  pending?: boolean
}) {
  const t = useTranslations("projects.deleteRequest")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${id}/delete-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }
      toast.success(t("requested", { name }))
      setOpen(false)
      setReason("")
      router.refresh()
    } catch {
      toast.error(t("failed"))
    } finally {
      setSubmitting(false)
    }
  }

  if (pending) {
    return (
      <Button variant="outline" size="sm" disabled className="text-muted-foreground">
        <Trash2 />
        {t("alreadyPending")}
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
          <Trash2 />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("title", { name })}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="delete-reason">{t("reasonLabel")}</Label>
            <Textarea
              id="delete-reason"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("reasonPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || reason.trim().length === 0}>
              {submitting ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
