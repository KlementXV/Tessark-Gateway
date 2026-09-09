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
import type { PublicSource } from "@/lib/sources/public"
import type { SourcePreset } from "@/lib/sources/presets"
import { SourceConnectionTest } from "@/components/sources/source-connection-test"
import { SourcePresetPicker } from "@/components/sources/source-preset-picker"

export interface SourceFormValues {
  name: string
  host: string
  authType: "none" | "basic" | "token"
  username: string
  secret: string
  /** One glob per line — the textarea shape of UpstreamSource.allowedRepos. */
  allowedRepos: string
  enabled: boolean
  description: string
}

const EMPTY_FORM: SourceFormValues = {
  name: "",
  host: "",
  authType: "none",
  username: "",
  secret: "",
  allowedRepos: "",
  enabled: true,
  description: "",
}

function toForm(source: PublicSource): SourceFormValues {
  return {
    name: source.name,
    host: source.host,
    authType: source.authType as SourceFormValues["authType"],
    username: source.username ?? "",
    secret: "",
    allowedRepos: source.allowedRepos.join("\n"),
    enabled: source.enabled,
    description: source.description ?? "",
  }
}

// One line per glob, blanks dropped — an admin edits this as a list, the API takes an array.
function parseGlobs(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
}

function fromPreset(preset: SourcePreset, description: string): SourceFormValues {
  return {
    ...EMPTY_FORM,
    name: preset.name,
    host: preset.host,
    authType: preset.authType,
    allowedRepos: preset.allowedRepos.join("\n"),
    description,
  }
}

export function SourceFormDialog({
  source,
  trigger,
  existingHosts = [],
}: {
  source?: PublicSource
  trigger?: React.ReactNode
  /** Hosts already configured — their presets are shown as taken, since `host` is unique. */
  existingHosts?: string[]
}) {
  const t = useTranslations("sources.form")
  const tPresets = useTranslations("sources.presets")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [form, setForm] = React.useState<SourceFormValues>(source ? toForm(source) : EMPTY_FORM)
  const [picked, setPicked] = React.useState<SourcePreset | null>(null)

  function update<K extends keyof SourceFormValues>(key: K, value: SourceFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function reset() {
    setForm(source ? toForm(source) : EMPTY_FORM)
    setPicked(null)
  }

  // Choosing a preset overwrites the fields wholesale — it is a starting point, and a partial
  // fill would leave the form describing two registries at once.
  // Presets are static data (src/lib/sources/presets.ts) whose prose lives in the catalogue
  // under sources.presets.<id>, so it follows the UI language. The ids are not a closed type
  // in the catalogue's eyes, hence the cast — `has()` guards the optional hint at runtime.
  type PresetKey = Parameters<typeof tPresets>[0]
  function choose(preset: SourcePreset | null) {
    setForm(preset ? fromPreset(preset, tPresets(`${preset.id}.description` as PresetKey)) : EMPTY_FORM)
    setPicked(preset)
  }
  const pickedHintKey = picked ? (`${picked.id}.hint` as PresetKey) : null
  const pickedHint = pickedHintKey && tPresets.has(pickedHintKey) ? tPresets(pickedHintKey) : null

  const globs = parseGlobs(form.allowedRepos)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch(source ? `/api/sources/${source.id}` : "/api/sources", {
        method: source ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          host: form.host.trim().toLowerCase(),
          authType: form.authType,
          username: form.authType !== "none" ? form.username || null : null,
          // Left blank on an edit, the stored credential is kept — see PATCH /api/sources/[id].
          ...(form.secret ? { secret: form.secret } : source ? {} : { secret: null }),
          allowedRepos: globs,
          enabled: form.enabled,
          description: form.description || null,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("saveFailed")))
        return
      }

      toast.success(source ? t("updated") : t("added", { name: form.name }))
      reset()
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopening starts clean rather than on whatever was half-typed last time.
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <Plus />
            {t("addTrigger")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{source ? t("editTitle") : t("addTitle")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto py-4">
            {!source && (
              <SourcePresetPicker
                value={picked?.id ?? ""}
                existingHosts={existingHosts}
                onSelect={choose}
              />
            )}

            {pickedHint && (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground dark:text-warning">
                {pickedHint}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="sourceName">{t("name")}</Label>
              <Input
                id="sourceName"
                required
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="sourceHost">{t("host")}</Label>
              <Input
                id="sourceHost"
                required
                value={form.host}
                onChange={(e) => update("host", e.target.value)}
                placeholder={t("hostPlaceholder")}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {t.rich("hostHint", { code: (chunks) => <code>{chunks}</code> })}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="allowedRepos">{t("allowedRepos")}</Label>
              <Textarea
                id="allowedRepos"
                value={form.allowedRepos}
                onChange={(e) => update("allowedRepos", e.target.value)}
                placeholder={t("allowedReposPlaceholder")}
                className="font-mono text-sm"
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                {t.rich("allowedReposHint", { code: (chunks) => <code>{chunks}</code> })}
              </p>
              {globs.length === 0 && (
                <p className="text-xs text-warning">{t("allowedReposEmpty")}</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t("auth")}</Label>
              <Select
                value={form.authType}
                onValueChange={(v) => update("authType", v as SourceFormValues["authType"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("authNone")}</SelectItem>
                  <SelectItem value="basic">{t("authBasic")}</SelectItem>
                  <SelectItem value="token">{t("authToken")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.authType !== "none" && (
              <div className="grid grid-cols-2 gap-4">
                {form.authType === "basic" && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="sourceUsername">{t("username")}</Label>
                    <Input
                      id="sourceUsername"
                      value={form.username}
                      onChange={(e) => update("username", e.target.value)}
                    />
                  </div>
                )}
                <div className={`flex flex-col gap-2 ${form.authType === "token" ? "col-span-2" : ""}`}>
                  <Label htmlFor="sourceSecret">
                    {form.authType === "basic" ? t("password") : t("token")}
                  </Label>
                  <Input
                    id="sourceSecret"
                    type="password"
                    value={form.secret}
                    onChange={(e) => update("secret", e.target.value)}
                    placeholder={source?.hasSecret ? t("unchanged") : undefined}
                  />
                </div>
              </div>
            )}

            <SourceConnectionTest
              sourceId={source?.id}
              host={form.host}
              authType={form.authType}
              username={form.username}
              secret={form.secret}
              globs={globs}
              presetRepo={picked?.probeRepo ?? ""}
            />

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="sourceEnabled">{t("enabled")}</Label>
                <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
              </div>
              <Switch
                id="sourceEnabled"
                checked={form.enabled}
                onCheckedChange={(v) => update("enabled", v)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="sourceDescription">{t("descriptionLabel")}</Label>
              <Textarea
                id="sourceDescription"
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting || !form.name || !form.host}>
              {submitting ? tc("saving") : source ? t("save") : t("addTrigger")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
