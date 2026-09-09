"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FolderInput } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { extractErrorMessage } from "@/lib/api-error"

export interface MoveTargetCluster {
  id: string
  name: string
  memberCount: number
}

/**
 * Moving a project to another cluster.
 *
 * The dialog is deliberately explicit that this is not a copy: the project is deleted on its
 * current Harbors and recreated on the target's. The API refuses a project that still holds
 * repositories, so the warning here matches what would happen rather than promising more.
 */
export function MoveProjectDialog({
  id,
  name,
  clusters,
}: {
  id: string
  name: string
  clusters: MoveTargetCluster[]
}) {
  const t = useTranslations("projects.move")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [target, setTarget] = React.useState<string>("")
  const [moving, setMoving] = React.useState(false)

  async function handleMove() {
    if (!target) return
    setMoving(true)
    try {
      const res = await fetch(`/api/projects/${id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusterId: target }),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }

      const summary = body as {
        removed: { queued: number; failures: Array<{ registry: string }> }
        targetMembers: number
        mirrorsToReapply: Array<{ id: string; name: string }>
      }
      const clusterName = clusters.find((cluster) => cluster.id === target)?.name ?? ""
      toast.success(t("moved", { name, cluster: clusterName, members: summary.targetMembers }))

      // Two things the move cannot finish on its own, said once each rather than buried in a
      // summary nobody reads: a Harbor that was down still owes the old delete, and a mirror
      // that pointed here is paused until somebody reinstalls it.
      if (summary.removed.queued > 0) {
        toast.warning(t("removalQueued", { count: summary.removed.queued }))
      }
      if (summary.mirrorsToReapply.length > 0) {
        toast.warning(
          t("mirrorsPaused", {
            count: summary.mirrorsToReapply.length,
            names: summary.mirrorsToReapply.map((mirror) => mirror.name).join(", "),
          }),
        )
      }

      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("failed"))
    } finally {
      setMoving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setTarget("")
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={clusters.length === 0}>
          <FolderInput />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="move-target-cluster">{t("targetLabel")}</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="move-target-cluster" className="w-full">
              <SelectValue placeholder={t("targetPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {clusters.map((cluster) => (
                <SelectItem key={cluster.id} value={cluster.id}>
                  {cluster.name} · {t("memberCount", { count: cluster.memberCount })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-5 text-muted-foreground">{t("warning")}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {tc("cancel")}
          </Button>
          <Button disabled={!target || moving} onClick={handleMove}>
            {moving ? t("moving") : t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
