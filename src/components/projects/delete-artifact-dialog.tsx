"use client"

import * as React from "react"
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

/**
 * Removing an artifact, or a whole repository, from every Harbor of the project's cluster.
 *
 * Two things this dialog has to say out loud, because neither is visible from the row it sits
 * on. An artifact is deleted by digest, so *every tag* pointing at it goes — someone dropping
 * `:1.26` has to see that `:stable` is the same object before they confirm. And the deletion is
 * fanned out: it is not "remove it from the Harbor I am looking at", it is the image leaving
 * the cluster, which is what makes it stick when replication runs next.
 *
 * A whole repository asks for its name to be typed, like deleting a project does. An artifact
 * does not: it is one object, named on screen, and a confirmation nobody reads is worse than
 * one that is asked only when the blast radius is unbounded.
 */
export function DeleteArtifactDialog({
  projectId,
  repo,
  digest,
  tags = [],
  artifactCount,
  onDeleted,
}: {
  projectId: string
  repo: string
  /** Null deletes the repository itself, artifacts and all. */
  digest: string | null
  tags?: string[]
  /** How many artifacts the repository holds — only for the repository form. */
  artifactCount?: number
  onDeleted: () => void
}) {
  const t = useTranslations("projects.images.delete")
  const tc = useTranslations("common")
  const [open, setOpen] = React.useState(false)
  const [confirmation, setConfirmation] = React.useState("")
  const [deleting, setDeleting] = React.useState(false)

  const isRepository = digest === null
  const confirmed = !isRepository || confirmation.trim() === repo

  async function handleDelete() {
    setDeleting(true)
    try {
      const query = new URLSearchParams({ repo })
      if (digest) query.set("digest", digest)
      const res = await fetch(`/api/projects/${projectId}/images?${query}`, { method: "DELETE" })
      const body = (await res.json().catch(() => null)) as
        | { deleted: number; queued: number; failures: Array<{ registry: string; error: string }> }
        | null

      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }

      // A Harbor that did not answer is named rather than folded into a success: the image is
      // still being served there until the reconciler drains the queue.
      if (body && body.failures.length > 0) {
        toast.warning(
          t("partial", {
            registries: body.failures.map((failure) => failure.registry).join(", "),
            count: body.queued,
          }),
        )
      } else {
        toast.success(isRepository ? t("repositoryDeleted", { repo }) : t("artifactDeleted"))
      }

      setOpen(false)
      setConfirmation("")
      onDeleted()
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
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={isRepository ? t("repositoryTrigger", { repo }) : t("artifactTrigger")}
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isRepository ? t("repositoryTitle", { repo }) : t("artifactTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isRepository
              ? t("repositoryDescription", { count: artifactCount ?? 0 })
              : t("artifactDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!isRepository && (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <code className="break-all font-mono text-muted-foreground">{digest}</code>
            {tags.length > 0 ? (
              <p>
                {t("tagsGoToo", { tags: tags.join(", ") })}
              </p>
            ) : (
              <p className="text-muted-foreground">{t("untagged")}</p>
            )}
          </div>
        )}

        {isRepository && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-repo-name">
              {t.rich("confirmLabel", {
                repo,
                code: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </Label>
            <Input
              id="confirm-repo-name"
              autoComplete="off"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </div>
        )}

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
