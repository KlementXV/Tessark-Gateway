"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CalendarClock, Plus } from "lucide-react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SCHEDULE_PRESETS } from "@/lib/mirrors/cron"
import type { TransferDestination, TransferSourceRegistry } from "@/lib/projects/service"
import type { PickableSource } from "@/lib/sources/public"

/**
 * Defining a mirror: the same source/destination pickers a transfer uses, plus the two things
 * that make it repeat — a schedule and a transport.
 *
 * The transport is not a hidden default: which of the two runs the copy decides who needs
 * network access to the upstream (the destination Harbor, or this pod), and an operator
 * picking a destination the Gateway does not administer has to be told why only one of them
 * is left. So the choice is on the form, with the constraint enforced as you pick.
 */
export function MirrorFormDialog({
  sources,
  sourceRegistries,
  destinations,
}: {
  sources: PickableSource[]
  sourceRegistries: TransferSourceRegistry[]
  destinations: TransferDestination[]
}) {
  const t = useTranslations("mirrors")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  const [name, setName] = React.useState("")
  const [sourceKey, setSourceKey] = React.useState(
    sources[0] ? `upstream:${sources[0].id}` : sourceRegistries[0] ? `registry:${sourceRegistries[0].id}` : "",
  )
  const [sourceProject, setSourceProject] = React.useState("")
  const [repo, setRepo] = React.useState("")
  const [tag, setTag] = React.useState("latest")
  const [destinationKey, setDestinationKey] = React.useState("")
  const [schedule, setSchedule] = React.useState("0 3 * * *")
  const [transport, setTransport] = React.useState<"harbor" | "skopeo">("harbor")
  const [enabled, setEnabled] = React.useState(true)

  const upstreamSource = sources.find((s) => `upstream:${s.id}` === sourceKey)
  const registrySource = sourceRegistries.find((r) => `registry:${r.id}` === sourceKey)
  const destination = destinations.find((d) => destinationOptionKey(d) === destinationKey)

  // A delivery Harbor is one the Gateway does not administer, so it can hold no policy of
  // ours — the transport collapses to skopeo, and the form says so rather than failing on
  // submit with a 400. Derived rather than pushed into state by an effect, so picking a
  // managed destination again restores whatever the operator had chosen.
  const harborBlocked = destination?.kind === "delivery"
  const effectiveTransport = harborBlocked ? "skopeo" : transport

  function reset() {
    setName("")
    setRepo("")
    setTag("latest")
    setSourceProject("")
    setDestinationKey("")
    setSchedule("0 3 * * *")
    setTransport("harbor")
    setEnabled(true)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!destination) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/mirrors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          ...(upstreamSource
            ? { sourceId: upstreamSource.id }
            : { sourceRegistryId: registrySource?.id, sourceProjectName: sourceProject }),
          repo,
          tag: tag || "latest",
          ...(destination.kind === "project"
            ? { projectId: destination.id }
            : { destRegistryId: destination.registryId, destProjectName: destination.name }),
          schedule,
          transport: effectiveTransport,
          enabled,
        }),
      })

      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("createFailed")))
        return
      }

      // The row is saved even when the transport refused to install it, so the toast has to
      // tell the two apart — "created" and "created but not running" are different news.
      if (body && body.applied === false) {
        toast.warning(t("createdNotApplied", { error: body.lastError ?? "" }))
      } else {
        toast.success(t("created"))
      }
      reset()
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("createFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  const blocked =
    sources.length === 0 && sourceRegistries.length === 0
      ? t("noSource")
      : destinations.length === 0
        ? t("noDestination")
        : undefined

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {blocked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex w-full sm:w-auto" tabIndex={0}>
              <Button disabled className="w-full sm:w-auto">
                <Plus />
                {t("newMirror")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 text-pretty">{blocked}</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger asChild>
          <Button>
            <Plus />
            {t("newMirror")}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("newTitle")}</DialogTitle>
            <DialogDescription>{t("newDescription")}</DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="mirror-name">{t("name")}</Label>
              <Input
                id="mirror-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("namePlaceholder")}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="mirror-source">{t("source")}</Label>
              <Select
                value={sourceKey}
                onValueChange={(value) => {
                  setSourceKey(value)
                  setSourceProject("")
                }}
              >
                <SelectTrigger id="mirror-source">
                  <SelectValue placeholder={t("pickSource")} />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={`upstream:${source.id}`}>
                      {source.name} ({source.host})
                    </SelectItem>
                  ))}
                  {sourceRegistries.map((registry) => (
                    <SelectItem key={registry.id} value={`registry:${registry.id}`}>
                      {registry.name} ({registry.host})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {upstreamSource && (
                <p className="text-xs text-muted-foreground">
                  {t("allowedHere")}{" "}
                  <code className="font-mono">{upstreamSource.allowedRepos.join("  ")}</code>
                </p>
              )}
            </div>

            {registrySource && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-source-project">{t("sourceProject")}</Label>
                <Select value={sourceProject} onValueChange={setSourceProject}>
                  <SelectTrigger id="mirror-source-project">
                    <SelectValue placeholder={t("sourceProject")} />
                  </SelectTrigger>
                  <SelectContent>
                    {registrySource.projects.map((project) => (
                      <SelectItem key={project} value={project}>
                        {project}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-repo">{t("repository")}</Label>
                <Input
                  id="mirror-repo"
                  required
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="library/nginx"
                  className="font-mono text-sm"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-tag">{t("tag")}</Label>
                <Input
                  id="mirror-tag"
                  required
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="mirror-destination">{t("destination")}</Label>
              <Select value={destinationKey} onValueChange={setDestinationKey}>
                <SelectTrigger id="mirror-destination">
                  <SelectValue placeholder={t("pickDestination")} />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((option) => (
                    <SelectItem key={destinationOptionKey(option)} value={destinationOptionKey(option)}>
                      {option.kind === "project"
                        ? option.name
                        : `${option.registryName} · ${option.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-schedule">{t("schedule")}</Label>
                <Input
                  id="mirror-schedule"
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
                <p className="text-xs text-muted-foreground">{t("scheduleHint")}</p>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-transport">{t("transport")}</Label>
                <Select
                  value={effectiveTransport}
                  onValueChange={(value) => setTransport(value as "harbor" | "skopeo")}
                >
                  <SelectTrigger id="mirror-transport">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="harbor" disabled={harborBlocked}>
                      {t("transportHarbor")}
                    </SelectItem>
                    <SelectItem value="skopeo">{t("transportSkopeo")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {harborBlocked
                    ? t("transportDeliveryHint")
                    : effectiveTransport === "harbor"
                      ? t("transportHarborHint")
                      : t("transportSkopeoHint")}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
              <div>
                <p className="text-sm font-medium">{t("enabled")}</p>
                <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !destination}>
              <CalendarClock />
              {submitting ? t("creating") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// The same keying the transfer dialog uses: a project id names a managed destination, and a
// delivery one needs its Harbor too, because the same project name exists on several.
function destinationOptionKey(option: TransferDestination): string {
  return option.kind === "project" ? `project:${option.id}` : `delivery:${option.registryId}:${option.name}`
}
