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
import { Textarea } from "@/components/ui/textarea"
import { isValidClusterRegistryHost } from "@/lib/clusters/registry-url"

export interface ClusterFormValues {
  name: string
  description: string
  /** The published host users pull from, in front of the members. Empty when unset. */
  registryUrl: string
  replicationMode: "event_based" | "scheduled" | "none"
  replicationCron: string
  /** Whose directory names this cluster's users — see ClusterIdentityMode in the schema. */
  identityMode: "GATEWAY" | "MAPPED"
}

const MODE_HELP_KEYS: Record<ClusterFormValues["replicationMode"], "helpEvent" | "helpScheduled" | "helpNone"> = {
  event_based: "helpEvent",
  scheduled: "helpScheduled",
  none: "helpNone",
}

const EMPTY_FORM: ClusterFormValues = {
  name: "",
  description: "",
  registryUrl: "",
  replicationMode: "event_based",
  replicationCron: "0 0 * * * *",
  identityMode: "GATEWAY",
}

export function ClusterFormDialog({
  cluster,
  trigger,
}: {
  cluster?: { id: string } & ClusterFormValues
  trigger?: React.ReactNode
}) {
  const t = useTranslations("clusters")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [form, setForm] = React.useState<ClusterFormValues>(
    cluster ?? EMPTY_FORM
  )
  const registryUrlError =
    form.registryUrl !== "" && !isValidClusterRegistryHost(form.registryUrl)
      ? t("registryUrlError")
      : null

  function update<K extends keyof ClusterFormValues>(key: K, value: ClusterFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch(cluster ? `/api/clusters/${cluster.id}` : "/api/clusters", {
        method: cluster ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description || null,
          registryUrl: form.registryUrl || null,
          replicationMode: form.replicationMode,
          replicationCron: form.replicationMode === "scheduled" ? form.replicationCron : null,
          identityMode: form.identityMode,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("saveFailed")))
        return
      }

      toast.success(cluster ? t("updated") : t("created", { name: form.name }))
      if (!cluster) setForm(EMPTY_FORM)
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus />
            {t("newCluster")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{cluster ? t("editCluster") : t("newCluster")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="clusterName">{t("name")}</Label>
              <Input
                id="clusterName"
                required
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="clusterRegistryUrl">{t("registryAddress")}</Label>
              <Input
                id="clusterRegistryUrl"
                value={form.registryUrl}
                onChange={(e) => update("registryUrl", e.target.value)}
                placeholder="registry.local"
                className="font-mono text-sm"
                aria-invalid={Boolean(registryUrlError)}
              />
              <p
                className={`text-xs ${registryUrlError ? "text-destructive" : "text-muted-foreground"}`}
              >
                {registryUrlError ?? t("registryAddressHint")}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t("replication")}</Label>
              <Select
                value={form.replicationMode}
                onValueChange={(v) => update("replicationMode", v as ClusterFormValues["replicationMode"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="event_based">{t("modeEvent")}</SelectItem>
                  <SelectItem value="scheduled">{t("modeScheduled")}</SelectItem>
                  <SelectItem value="none">{t("modeNone")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(MODE_HELP_KEYS[form.replicationMode])}</p>
            </div>

            {form.replicationMode === "scheduled" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="cron">{t("schedule")}</Label>
                <Input
                  id="cron"
                  required
                  value={form.replicationCron}
                  onChange={(e) => update("replicationCron", e.target.value)}
                  placeholder="0 0 * * * *"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t.rich("scheduleHint", { code: (chunks) => <code>{chunks}</code> })}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label>{t("identity")}</Label>
              <Select
                value={form.identityMode}
                onValueChange={(v) => update("identityMode", v as ClusterFormValues["identityMode"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GATEWAY">{t("identityGateway")}</SelectItem>
                  <SelectItem value="MAPPED">{t("identityMapped")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(form.identityMode === "MAPPED" ? "identityHelpMapped" : "identityHelpGateway")}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="clusterDescription">{t("descriptionLabel")}</Label>
              <Textarea
                id="clusterDescription"
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting || !form.name || Boolean(registryUrlError)}>
              {submitting ? tc("saving") : cluster ? t("save") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
