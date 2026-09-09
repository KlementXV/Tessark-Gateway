"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus } from "lucide-react"
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
import type { PublicTransferRule } from "@/lib/transfers/rule-service"

// "Any" is the wildcard on either side of a rule, stored as null. A Select needs a non-empty
// string value, so the sentinel lives here and is translated back on submit.
const ANY = "__any__"

export interface RulePickable {
  id: string
  name: string
}

export function TransferRuleFormDialog({
  rule,
  upstreams,
  registries,
}: {
  /** Absent when creating. */
  rule?: PublicTransferRule
  upstreams: RulePickable[]
  registries: RulePickable[]
}) {
  const t = useTranslations("transferRules.form")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  const [name, setName] = React.useState(rule?.name ?? "")
  const [description, setDescription] = React.useState(rule?.description ?? "")
  // One control for both source forms: a rule has one source, so offering two pickers would
  // invite the combination the schema rejects.
  const [source, setSource] = React.useState(
    rule?.sourceUpstreamId ? `upstream:${rule.sourceUpstreamId}`
      : rule?.sourceRegistryId ? `registry:${rule.sourceRegistryId}`
      : ANY,
  )
  const [dest, setDest] = React.useState(rule?.destRegistryId ?? ANY)
  const [repoFilter, setRepoFilter] = React.useState((rule?.repoFilter ?? ["**"]).join("\n"))
  const [projectFilter, setProjectFilter] = React.useState((rule?.projectFilter ?? ["**"]).join("\n"))
  const [requiresApproval, setRequiresApproval] = React.useState(rule?.requiresApproval ?? true)
  // Kept as the raw JSON an operator edits. Anything unparseable is refused on submit rather
  // than silently dropped — a typo in a resource limit must not become "instance defaults".
  const [overrides, setOverrides] = React.useState(
    JSON.stringify(rule?.skopeoOverrides ?? {}, null, 2),
  )
  const [advanced, setAdvanced] = React.useState(
    Object.keys(rule?.skopeoOverrides ?? {}).length > 0,
  )
  const [enabled, setEnabled] = React.useState(rule?.enabled ?? true)

  function globs(raw: string): string[] {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    let parsedOverrides: unknown
    try {
      parsedOverrides = overrides.trim() ? JSON.parse(overrides) : {}
    } catch {
      toast.error(t("overridesInvalid"))
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(rule ? `/api/transfer-rules/${rule.id}` : "/api/transfer-rules", {
        method: rule ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          sourceUpstreamId: source.startsWith("upstream:") ? source.slice("upstream:".length) : null,
          sourceRegistryId: source.startsWith("registry:") ? source.slice("registry:".length) : null,
          destRegistryId: dest === ANY ? null : dest,
          repoFilter: globs(repoFilter),
          projectFilter: globs(projectFilter),
          requiresApproval,
          enabled,
          skopeoOverrides: parsedOverrides,
        }),
      })

      if (!res.ok) {
        toast.error(extractErrorMessage(await res.json().catch(() => null), t("failed")))
        return
      }

      toast.success(rule ? t("updated") : t("created", { name }))
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {rule ? (
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("editAria", { name: rule.name })}>
            <Pencil />
          </Button>
        ) : (
          <Button>
            <Plus />
            {t("newTrigger")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{rule ? t("editTitle") : t("newTitle")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-name">{t("name")}</Label>
              <Input
                id="rule-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label>{t("source")}</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("anySource")}</SelectItem>
                    {upstreams.map((upstream) => (
                      <SelectItem key={upstream.id} value={`upstream:${upstream.id}`}>
                        {upstream.name}
                      </SelectItem>
                    ))}
                    {registries.map((registry) => (
                      <SelectItem key={registry.id} value={`registry:${registry.id}`}>
                        {registry.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label>{t("destination")}</Label>
                <Select value={dest} onValueChange={setDest}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("anyDestination")}</SelectItem>
                    {registries.map((registry) => (
                      <SelectItem key={registry.id} value={registry.id}>
                        {registry.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-repos">{t("repoFilter")}</Label>
              <Textarea
                id="rule-repos"
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                className="font-mono text-xs"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">{t("globHint")}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-projects">{t("projectFilter")}</Label>
              <Textarea
                id="rule-projects"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="font-mono text-xs"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">{t("projectFilterHint")}</p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <Label htmlFor="rule-approval">{t("requiresApproval")}</Label>
                <p className="text-xs text-muted-foreground">{t("requiresApprovalHint")}</p>
              </div>
              <Switch id="rule-approval" checked={requiresApproval} onCheckedChange={setRequiresApproval} />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <Label htmlFor="rule-enabled">{t("enabled")}</Label>
                <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
              </div>
              <Switch id="rule-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <Label htmlFor="rule-advanced">{t("advanced")}</Label>
                <p className="text-xs text-muted-foreground">{t("advancedHint")}</p>
              </div>
              <Switch id="rule-advanced" checked={advanced} onCheckedChange={setAdvanced} />
            </div>

            {advanced && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="rule-overrides">{t("overrides")}</Label>
                <Textarea
                  id="rule-overrides"
                  value={overrides}
                  onChange={(e) => setOverrides(e.target.value)}
                  className="font-mono text-xs"
                  rows={6}
                />
                <p className="text-xs text-muted-foreground">{t("overridesHint")}</p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-description">{t("descriptionLabel")}</Label>
              <Textarea
                id="rule-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting || !name}>
              {submitting ? tc("saving") : tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
