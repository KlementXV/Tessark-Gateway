"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface ClusterTarget {
  id: string
  name: string
  memberCount: number
}

/**
 * One dialog, two flows. An admin's project is created on the cluster the moment they
 * submit (the API does it — see src/app/api/projects/route.ts), so the wording here has to
 * promise the right thing: "Request" and "waiting for approval" would be a lie for them,
 * and "Create" would be one for everybody else.
 */
export function RequestProjectDialog({
  clusters,
  canCreateDirectly = false,
}: {
  clusters: ClusterTarget[]
  canCreateDirectly?: boolean
}) {
  const t = useTranslations("projects.request")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [form, setForm] = React.useState({
    name: "",
    description: "",
    clusterId: clusters[0]?.id ?? "",
    isPublic: false,
  })

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const verb = canCreateDirectly
    ? {
        trigger: t("createTrigger"),
        title: t("createTitle"),
        description: t("createDescription"),
        submit: t("createSubmit"),
        pending: t("createPending"),
        failure: t("createFailure"),
      }
    : {
        trigger: t("requestTrigger"),
        title: t("requestTitle"),
        description: t("requestDescription"),
        submit: t("requestSubmit"),
        pending: t("requestPending"),
        failure: t("requestFailure"),
      }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, description: form.description || null }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, verb.failure))
        return
      }

      if (canCreateDirectly) {
        // Partial fan-out still counts as created — say which Harbors are behind rather
        // than reporting a flat success the cluster doesn't back up yet.
        const failed = (await res.json().catch(() => null))?.placements?.failed ?? 0
        toast.success(
          failed > 0
            ? t("createdPartial", { name: form.name, count: failed })
            : t("created", { name: form.name }),
        )
      } else {
        toast.success(t("requested", { name: form.name }))
      }

      setForm({ name: "", description: "", clusterId: clusters[0]?.id ?? "", isPublic: false })
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(verb.failure)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex w-full sm:w-auto" tabIndex={clusters.length === 0 ? 0 : undefined}>
            <DialogTrigger asChild>
              <Button disabled={clusters.length === 0} className="w-full sm:w-auto">
                <Plus />
                {verb.trigger}
              </Button>
            </DialogTrigger>
          </span>
        </TooltipTrigger>
        {clusters.length === 0 && (
          <TooltipContent>{t("needCluster")}</TooltipContent>
        )}
      </Tooltip>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{verb.title}</DialogTitle>
            <DialogDescription>{verb.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t("name")}</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-cluster">{t("cluster")}</Label>
              <Select value={form.clusterId} onValueChange={(v) => update("clusterId", v)}>
                <SelectTrigger id="project-cluster">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {clusters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {t("clusterOption", { name: c.name, count: c.memberCount })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="description">{t("description")}</Label>
              <Textarea
                id="description"
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="isPublic">{t("publicProject")}</Label>
                <span className="text-xs text-muted-foreground">{t("publicHint")}</span>
              </div>
              <Switch
                id="isPublic"
                checked={form.isPublic}
                onCheckedChange={(checked) => update("isPublic", checked)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting || !form.clusterId}>
              {submitting ? verb.pending : verb.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
