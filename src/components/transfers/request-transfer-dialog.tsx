"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Download, Globe2, Send } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { Badge } from "@/components/ui/badge"
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
import { parseImageList, type ImageListSource, type InvalidLine } from "@/lib/transfers/image-list"
import type { PickableSource } from "@/lib/sources/public"

/**
 * A Harbor that can be transferred *out of* — the second source form.
 *
 * Its projects come with it rather than being fetched when the registry is picked: the list is
 * already loaded server-side for the destinations, and a second round-trip inside the dialog
 * would leave the requester waiting on a Harbor that may be slow or down.
 */
export interface TransferSourceRegistry {
  id: string
  name: string
  host: string
  projects: string[]
}

export type TransferDestinationOption =
  | { kind: "project"; id: string; name: string; isPublic: boolean }
  | {
      kind: "delivery"
      id: string
      name: string
      isPublic: boolean
      registryId: string
      registryName: string
    }

/**
 * Raising a transfer, from anywhere. A request can land in several destinations at once, so
 * this is not a per-project action — it lives in the Projects header, and the project detail
 * page reuses it with its own project pre-selected.
 *
 * One dialog, two flows: a transfer the rules let through starts mirroring the moment it is
 * submitted (the API launches it — see src/app/api/transfers/route.ts), so the wording must
 * not promise a review that never happens.
 *
 * Destinations outside the Gateway's own estate are grouped apart and labelled with the
 * Harbor they land on. Sending an image to a registry somebody else administers is not the
 * same act as mirroring into a project here, and the dialog should not let the two blur.
 */
export function RequestTransferDialog({
  sources,
  sourceRegistries = [],
  destinations,
  defaultProjectId,
  canTransferDirectly = false,
  hasEnterpriseCa = false,
  enterpriseCaJobDefault = true,
  disabledReason,
  trigger,
}: {
  // The registries an admin allows pulling from. Empty means the feature is unconfigured —
  // there is no free-text fallback by design.
  sources: PickableSource[]
  /** Harbors the requester may take an image from. Admin-only; empty for everyone else. */
  sourceRegistries?: TransferSourceRegistry[]
  destinations: TransferDestinationOption[]
  /** Pre-ticked destination. Omitted from the Projects header, where no project is implied. */
  defaultProjectId?: string
  canTransferDirectly?: boolean
  /**
   * Whether this instance has an enterprise CA configured (Policy › Enterprise CA). Only then
   * is the switch below offered: with nothing to drop, it would be one more control to read
   * past.
   */
  hasEnterpriseCa?: boolean
  /**
   * Where the switch starts: InstanceSettings.enterpriseCaJobDefault, set in Policy › Enterprise
   * CA. The requester overrides it for one transfer; they do not set the policy.
   */
  enterpriseCaJobDefault?: boolean
  /** Reason to keep the trigger disabled, on top of "no source configured". */
  disabledReason?: string
  trigger?: React.ReactNode
}) {
  const t = useTranslations("transfers")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  // One picker for both source forms, keyed the same way the destinations are: a prefix says
  // which shape the value is, so the two can never be set at once.
  const [sourceKey, setSourceKey] = React.useState(
    sources[0] ? `upstream:${sources[0].id}` : sourceRegistries[0] ? `registry:${sourceRegistries[0].id}` : "",
  )
  const [sourceProject, setSourceProject] = React.useState("")
  // One line, one image — "library/nginx:1.27", tag optional. A single line behaves exactly as
  // the two fields it replaces did; a pasted list is the same request repeated.
  const [imageList, setImageList] = React.useState("")
  // Every source the requester may name, flattened to the one shape the parser needs. A line
  // carrying a host is matched against this list, which is what keeps the host on the line from
  // being a registry nobody approved: an unknown one refuses the line.
  const catalog = React.useMemo<ImageListSource[]>(
    () => [
      ...sources.map((source) => ({ key: `upstream:${source.id}`, host: source.host })),
      ...sourceRegistries.map((registry) => ({
        key: `registry:${registry.id}`,
        host: registry.host,
        projects: registry.projects,
      })),
    ],
    [sources, sourceRegistries],
  )
  const parsed = React.useMemo(
    () =>
      parseImageList(imageList, {
        sources: catalog,
        defaultSourceKey: sourceKey || undefined,
        defaultSourceProject: sourceProject || undefined,
      }),
    [imageList, catalog, sourceKey, sourceProject],
  )
  const sourceByKey = React.useMemo(
    () => new Map(catalog.map((source) => [source.key, source])),
    [catalog],
  )
  // Only lines with no host of their own lean on the picker — a list that names every host is
  // complete without it, and must not be held back by an unpicked source project.
  const usesDefaultSource = parsed.images.some((image) => !image.detected)

  /** The full reference a parsed line resolved to, as the Job will be handed it. */
  function reference(image: (typeof parsed.images)[number]): string {
    const host = sourceByKey.get(image.sourceKey)?.host
    const project = image.sourceProject ? `${image.sourceProject}/` : ""
    return `${host ? `${host}/` : ""}${project}${image.repo}:${image.tag}`
  }

  /** Why a line was refused, in the reader's language — the parser only returns the code. */
  function invalidReason(entry: InvalidLine): string {
    switch (entry.reason) {
      case "unknownHost":
        return t("invalidUnknownHost", { host: entry.detail ?? "" })
      case "unknownProject":
        return t("invalidUnknownProject", { project: entry.detail ?? "" })
      case "missingProject":
        return t("invalidMissingProject")
      case "noSource":
        return t("invalidNoSource")
      default:
        return t("invalidSyntax")
    }
  }
  // destination id → repository path under it ("" means "same short name as the source").
  const initialSelection = React.useMemo(
    () => (defaultProjectId ? { [defaultProjectId]: "" } : {}),
    [defaultProjectId],
  )
  const [selected, setSelected] = React.useState<Record<string, string>>(initialSelection)
  // Starts from the instance default rather than a constant: an operator who turned copy jobs
  // off in Policy must not find every dialog pre-ticked back on.
  const [useCustomCa, setUseCustomCa] = React.useState(enterpriseCaJobDefault)

  const upstreamSource = sourceKey.startsWith("upstream:")
    ? sources.find((s) => `upstream:${s.id}` === sourceKey)
    : undefined
  const registrySource = sourceKey.startsWith("registry:")
    ? sourceRegistries.find((r) => `registry:${r.id}` === sourceKey)
    : undefined
  const selectedIds = Object.keys(selected)
  const byId = React.useMemo(
    () => new Map(destinations.map((destination) => [destination.id, destination])),
    [destinations],
  )
  // Two groups, rendered under their own headings: what lands here, and what leaves.
  const managed = destinations.filter((destination) => destination.kind === "project")
  const delivery = destinations.filter((destination) => destination.kind === "delivery")



  function reset() {
    setImageList("")
    setSourceProject("")
    setSelected(initialSelection)
    setUseCustomCa(enterpriseCaJobDefault)
  }

  function toggleDestination(id: string, checked: boolean) {
    setSelected((current) => {
      const next = { ...current }
      if (checked) next[id] = next[id] ?? ""
      else delete next[id]
      return next
    })
  }

  const verb = canTransferDirectly
    ? {
        trigger: t("transferTrigger"),
        title: t("transferTitle"),
        description: t("transferDescription"),
        submit: t("transferSubmit"),
        pending: t("transferPending"),
        failure: t("transferFailure"),
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
    // The server checks all of this again — this only avoids a round trip that could only fail.
    if (parsed.images.length === 0 || parsed.invalid.length > 0 || parsed.duplicates.length > 0) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The picked source travels as the batch default, and every image also carries the
          // source its own line resolved to. Sending both means the server reads exactly what
          // the preview showed, rather than re-deriving it from a host string.
          ...(upstreamSource
            ? { sourceId: upstreamSource.id }
            : registrySource && sourceProject
              ? { sourceRegistryId: registrySource.id, sourceProjectName: sourceProject }
              : {}),
          images: parsed.images.map((image) => ({
            repo: image.repo,
            tag: image.tag,
            ...(image.sourceKey.startsWith("upstream:")
              ? { sourceId: image.sourceKey.slice("upstream:".length) }
              : {
                  sourceRegistryId: image.sourceKey.slice("registry:".length),
                  sourceProjectName: image.sourceProject ?? undefined,
                }),
          })),
          useCustomCa,
          targets: selectedIds.map((id) => {
            const destination = byId.get(id)!
            const targetRepo = selected[id]?.trim() || null
            return destination.kind === "project"
              ? { projectId: destination.id, targetRepo }
              : {
                  destRegistryId: destination.registryId,
                  destProjectName: destination.name,
                  targetRepo,
                }
          }),
        }),
      })

      const body = (await res.json().catch(() => null)) as {
        started?: { image: string }[]
        failed?: { image: string; error: string }[]
      } | null

      if (!res.ok) {
        // Every image refused for the same reason is the common case (a rule, a closed source),
        // so the first message is the useful one rather than a list saying it fourteen times.
        const first = body?.failed?.[0]
        toast.error(first ? `${first.image} — ${first.error}` : extractErrorMessage(body, verb.failure))
        return
      }

      const started = body?.started?.length ?? 0
      const failed = body?.failed ?? []
      // Partial outcomes are said out loud: a toast claiming success while two images were
      // refused is how an operator finds out a week later.
      if (failed.length > 0) {
        toast.warning(t("partial", { started, failed: failed.length }), {
          description: failed.map((entry) => `${entry.image} — ${entry.error}`).join("\n"),
        })
      } else {
        toast.success(
          canTransferDirectly ? t("started", { count: started }) : t("requested", { count: started }),
        )
      }
      reset()
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(verb.failure)
    } finally {
      setSubmitting(false)
    }
  }

  const blocked =
    disabledReason ??
    (sources.length === 0 && sourceRegistries.length === 0
      ? t("noSource")
      : destinations.length === 0
        ? t("noDestination")
        : undefined)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : blocked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex w-full sm:w-auto" tabIndex={0}>
              <Button variant="outline" disabled className="w-full sm:w-auto">
                <Download />
                {verb.trigger}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 text-pretty">{blocked}</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger asChild>
            <Button variant="outline">
              <Download />
              {verb.trigger}
            </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{verb.title}</DialogTitle>
            <DialogDescription>{verb.description}</DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="transfer-source">{t("defaultSource")}</Label>
              <Select value={sourceKey} onValueChange={(v) => { setSourceKey(v); setSourceProject("") }}>
                <SelectTrigger id="transfer-source">
                  <SelectValue placeholder={t("pickRegistry")} />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={`upstream:${s.id}`}>
                      {s.name} ({s.host})
                    </SelectItem>
                  ))}
                  {sourceRegistries.map((r) => (
                    <SelectItem key={r.id} value={`registry:${r.id}`}>
                      {r.name} ({r.host})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {upstreamSource && (
                <p className="text-xs text-muted-foreground">
                  {t("allowedHere")}
                  <code className="font-mono">{upstreamSource.allowedRepos.join("  ")}</code>
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t("defaultSourceHint")}</p>
            </div>

            {registrySource && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="source-project">{t("sourceProject")}</Label>
                <Select value={sourceProject} onValueChange={setSourceProject}>
                  <SelectTrigger id="source-project">
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

            <div className="flex flex-col gap-2">
              <Label htmlFor="images">{t("images")}</Label>
              <Textarea
                id="images"
                required
                rows={4}
                value={imageList}
                onChange={(e) => setImageList(e.target.value)}
                placeholder={t("imagesPlaceholder")}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("imagesHint")}</p>

              {parsed.duplicates.length > 0 && (
                <p className="text-xs text-destructive">
                  {t("duplicateLines", {
                    lines: parsed.duplicates
                      .map((entry) => t("duplicateLine", { line: entry.line, image: entry.text, firstLine: entry.firstLine }))
                      .join(" · "),
                  })}
                </p>
              )}
              {parsed.invalid.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs text-destructive">
                  {parsed.invalid.map((entry) => (
                    <li key={entry.line}>
                      <span className="font-mono">
                        {entry.line}: {entry.text}
                      </span>{" "}
                      — {invalidReason(entry)}
                    </li>
                  ))}
                </ul>
              )}

              {parsed.images.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2">
                  {/* The reference each line resolved to, host included — in a list mixing two
                      registries that host is the whole point of the preview. */}
                  {parsed.images.slice(0, 3).map((image) => (
                    <p
                      key={`${image.sourceKey}|${image.sourceProject ?? ""}|${image.repo}:${image.tag}`}
                      className="truncate font-mono text-xs text-muted-foreground"
                    >
                      {reference(image)}
                    </p>
                  ))}
                  {parsed.images.length > 3 && (
                    <p className="text-xs text-muted-foreground">
                      {t("andMore", { count: parsed.images.length - 3 })}
                    </p>
                  )}
                  {parsed.sourceKeys.length > 1 && (
                    <p className="pt-1 text-xs text-muted-foreground">
                      {t("multiSource", { count: parsed.sourceKeys.length })}
                    </p>
                  )}
                </div>
              )}
            </div>

            {hasEnterpriseCa && (
              <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div className="min-w-0">
                  <Label htmlFor="transfer-use-custom-ca">{t("useCustomCa")}</Label>
                  <p className="text-xs text-muted-foreground">{t("useCustomCaHint")}</p>
                  {!useCustomCa && (
                    <p className="pt-1 text-xs text-muted-foreground">{t("useCustomCaOffHint")}</p>
                  )}
                </div>
                <Switch
                  id="transfer-use-custom-ca"
                  checked={useCustomCa}
                  onCheckedChange={setUseCustomCa}
                />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label>{t("destinations")}</Label>
              <p className="text-xs text-muted-foreground">{t("destinationsHint")}</p>
              {managed.length > 0 && (
                <div className="flex flex-col divide-y overflow-hidden rounded-md border">
                  {managed.map((destination) => (
                    <DestinationRow
                      key={destination.id}
                      destination={destination}
                      checked={destination.id in selected}
                      repo={selected[destination.id] ?? ""}
                      isDefault={destination.id === defaultProjectId}
                      onToggle={toggleDestination}
                      onRepoChange={(value) =>
                        setSelected((c) => ({ ...c, [destination.id]: value }))
                      }
                    />
                  ))}
                </div>
              )}

              {delivery.length > 0 && (
                <>
                  <p className="pt-1 text-xs font-medium text-muted-foreground">
                    {t("deliveryHeading")}
                  </p>
                  <div className="flex flex-col divide-y overflow-hidden rounded-md border border-dashed">
                    {delivery.map((destination) => (
                      <DestinationRow
                        key={destination.id}
                        destination={destination}
                        checked={destination.id in selected}
                        repo={selected[destination.id] ?? ""}
                        isDefault={false}
                        onToggle={toggleDestination}
                        onRepoChange={(value) =>
                          setSelected((c) => ({ ...c, [destination.id]: value }))
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="submit"
              disabled={
                submitting ||
                parsed.images.length === 0 ||
                // A bad or repeated line blocks the whole submit rather than being skipped: the
                // list is what the operator meant to send, not a best-effort subset of it.
                parsed.invalid.length > 0 ||
                parsed.duplicates.length > 0 ||
                selectedIds.length === 0 ||
                // Only the lines that inherit the picked source need it to be complete: a list
                // where every line names its own host is submittable whatever the picker says.
                Boolean(usesDefaultSource && registrySource && !sourceProject)
              }
            >
              {submitting ? verb.pending : verb.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// One selectable destination. Extracted because the two groups render identically apart from
// the border of the box around them — the difference the user has to see is *where* the image
// goes, which the registry name carries, not a different row layout.
function DestinationRow({
  destination,
  checked,
  repo,
  isDefault,
  onToggle,
  onRepoChange,
}: {
  destination: TransferDestinationOption
  checked: boolean
  repo: string
  isDefault: boolean
  onToggle: (id: string, checked: boolean) => void
  onRepoChange: (value: string) => void
}) {
  const t = useTranslations("transfers")
  const label =
    destination.kind === "delivery"
      ? `${destination.registryName} · ${destination.name}`
      : destination.name

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {destination.kind === "delivery" && (
            <Send className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate text-sm">{label}</span>
          {destination.isPublic && <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />}
          {isDefault && (
            <Badge variant="outline" className="font-normal">
              {t("thisProject")}
            </Badge>
          )}
        </div>
        <Switch
          checked={checked}
          onCheckedChange={(v) => onToggle(destination.id, v)}
          aria-label={t("mirrorInto", { name: label })}
        />
      </div>
      {checked && (
        <Input
          value={repo}
          onChange={(e) => onRepoChange(e.target.value)}
          placeholder={t("pathPlaceholder", { name: destination.name })}
          className="h-8 font-mono text-xs"
        />
      )}
    </div>
  )
}
