"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { extractErrorMessage } from "@/lib/api-error"

export function DeleteProjectButton({
  id,
  name,
  returnTo = "/projects",
}: {
  id: string
  name: string
  returnTo?: string
}) {
  const t = useTranslations("projects.delete")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [confirmation, setConfirmation] = React.useState("")
  const [deleting, setDeleting] = React.useState(false)

  // Typing the name out: unlike removing a registry, this deletes the project on every
  // Harbor of the cluster, and nothing here can put it back.
  const confirmed = confirmation.trim() === name

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }

      const body = (await res.json()) as {
        queued: number
        failures: Array<{ registry: string; error: string }>
      }
      if (body.failures.length > 0) {
        toast.warning(
          body.queued > 0
            ? t("deletedUnreachable", { name, count: body.queued })
            : t("deletedRefused", {
                name,
                registries: body.failures.map((f) => f.registry).join(", "),
                error: body.failures[0].error,
              })
        )
      } else {
        toast.success(t("deleted", { name }))
      }

      router.push(returnTo)
      router.refresh()
    } catch {
      toast.error(t("failed"))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setConfirmation("")
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
          <Trash2 />
          {t("trigger")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title", { name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t.rich("description", { strong: (chunks) => <strong>{chunks}</strong> })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm-project-name">
            {t.rich("confirmLabel", { name, code: (chunks) => <span className="font-mono">{chunks}</span> })}
          </Label>
          <Input
            id="confirm-project-name"
            autoComplete="off"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
          <Button variant="destructive" disabled={!confirmed || deleting} onClick={handleDelete}>
            {deleting ? tc("deleting") : t("submit")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
