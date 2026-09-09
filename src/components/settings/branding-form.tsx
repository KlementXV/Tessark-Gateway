"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Check,
  CircleUserRound,
  FileImage,
  LoaderCircle,
  Palette,
  Save,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { BrandMark } from "@/components/layout/brand-mark"
import {
  normalizeHexColor,
  type InstanceBranding,
} from "@/lib/settings/branding"
import { ACCEPTED_LOGO_TYPES, isUploadedLogoUrl } from "@/lib/settings/logo"

function toFormState(branding: InstanceBranding) {
  return {
    brandName: branding.brandName,
    brandTagline: branding.brandTagline,
    logoUrl: branding.logoUrl ?? "",
    primaryColor: branding.primaryColor ?? "",
  }
}

function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Palette
  title: string
  description: string
}) {
  return (
    <header className="flex items-start gap-3 px-6 pt-6 pb-0 sm:px-8 sm:pt-8">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </header>
  )
}

export function BrandingForm({
  branding,
  maxLogoBytes,
}: {
  branding: InstanceBranding
  maxLogoBytes: number
}) {
  const t = useTranslations("settings.branding")
  const tc = useTranslations("common")
  const router = useRouter()
  const [submitting, setSubmitting] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [form, setForm] = React.useState(() => toFormState(branding))
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const hasUploadedLogo = isUploadedLogoUrl(form.logoUrl || null)

  // Re-sync after router.refresh() with the normalized values actually stored by the server.
  const saved = toFormState(branding)
  const savedKey = JSON.stringify(saved)
  const [lastSavedKey, setLastSavedKey] = React.useState(savedKey)
  if (savedKey !== lastSavedKey) {
    setLastSavedKey(savedKey)
    setForm(saved)
  }

  const dirty = savedKey !== JSON.stringify(form)
  useUnsavedChanges(dirty && !submitting)

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      if (file.size > maxLogoBytes) {
        toast.error(t("logoTooLarge", { kb: Math.round(maxLogoBytes / 1024) }))
        return
      }

      const body = new FormData()
      body.append("file", file)
      const res = await fetch("/api/settings/branding/logo", { method: "POST", body })

      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        toast.error(extractErrorMessage(payload, t("uploadFailed")))
        return
      }

      toast.success(t("uploaded"))
      router.refresh()
    } catch {
      toast.error(t("uploadFailed"))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function handleRemoveLogo() {
    setUploading(true)
    try {
      const res = await fetch("/api/settings/branding/logo", { method: "DELETE" })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        toast.error(extractErrorMessage(payload, t("removeFailed")))
        return
      }
      toast.success(t("removed"))
      router.refresh()
    } catch {
      toast.error(t("removeFailed"))
    } finally {
      setUploading(false)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch("/api/settings/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("updateFailed")))
        return
      }

      toast.success(t("updated"))
      router.refresh()
    } catch {
      toast.error(t("updateFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  const previewColor = normalizeHexColor(form.primaryColor)
  const invalidColor = form.primaryColor !== "" && previewColor === null
  const previewBrandName = form.brandName || t("brandNameFallback")

  return (
    <form
      onSubmit={handleSubmit}
      className="animate-enter"
    >
      <div className="min-w-0">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)]">
          <section>
            <SectionHeading
              icon={CircleUserRound}
              title={t("identity")}
              description={t("identityHint")}
            />
            <div className="grid gap-6 px-6 pt-6 pb-8 sm:grid-cols-2 sm:px-8 sm:pt-7 sm:pb-9">
              <div className="flex flex-col gap-2">
                <Label htmlFor="brandName">{t("brandName")}</Label>
                <Input
                  id="brandName"
                  value={form.brandName}
                  onChange={(event) => update("brandName", event.target.value)}
                  maxLength={60}
                  required
                  className="h-10"
                />
                <p className="text-xs leading-5 text-muted-foreground">{t("brandNameHint")}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="brandTagline">{t("productLabel")}</Label>
                <Input
                  id="brandTagline"
                  value={form.brandTagline}
                  onChange={(event) => update("brandTagline", event.target.value)}
                  maxLength={60}
                  placeholder={t("taglinePlaceholder")}
                  className="h-10"
                />
                <p className="text-xs leading-5 text-muted-foreground">{t("productLabelHint")}</p>
              </div>
            </div>
          </section>

          <section className="border-t">
          <SectionHeading
            icon={FileImage}
            title={t("logo")}
            description={t("logoHint")}
          />
          <div className="flex flex-col gap-6 px-6 pt-6 pb-8 sm:px-8 sm:pt-7 sm:pb-9">
            <div className="flex flex-col gap-5 rounded-xl border border-dashed bg-muted/20 p-5 sm:flex-row sm:items-center sm:p-6">
              <span className="flex size-16 shrink-0 items-center justify-center rounded-xl border bg-sidebar p-3 shadow-sm">
                <BrandMark
                  brandName={previewBrandName}
                  logoUrl={form.logoUrl || null}
                  className="size-full"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {hasUploadedLogo ? t("uploadedLogo") : form.logoUrl ? t("remoteLogo") : t("defaultMark")}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("logoFormats", { kb: Math.round(maxLogoBytes / 1024) })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <input
                  id="logoFile"
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_LOGO_TYPES.join(",")}
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleUpload(file)
                  }}
                  className="sr-only"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}
                  {uploading ? t("uploading") : t("upload")}
                </Button>
                {hasUploadedLogo && !uploading && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("removeUploaded")}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void handleRemoveLogo()}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="logoUrl">{t("externalUrl")}</Label>
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t("alternative")}
                </span>
              </div>
              <Input
                id="logoUrl"
                value={hasUploadedLogo ? "" : form.logoUrl}
                onChange={(event) => update("logoUrl", event.target.value)}
                disabled={hasUploadedLogo}
                placeholder={hasUploadedLogo ? t("removeUploadFirst") : "https://example.com/logo.svg"}
                className="h-10"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {hasUploadedLogo ? t("uploadPriority") : t("urlHint")}
              </p>
            </div>
          </div>
          </section>

          <section className="border-t">
          <SectionHeading
            icon={Palette}
            title={t("accentColor")}
            description={t("accentHint")}
          />
          <div className="px-6 pt-6 pb-8 sm:px-8 sm:pt-7 sm:pb-9">
            <div className="flex flex-col gap-2">
              <Label htmlFor="primaryColor">{t("hexValue")}</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  id="primaryColor"
                  value={form.primaryColor}
                  onChange={(event) => update("primaryColor", event.target.value)}
                  placeholder={t("hexPlaceholder")}
                  className="h-10 max-w-44 font-mono"
                  aria-invalid={invalidColor}
                />
                <label className="group relative flex h-10 items-center gap-2 rounded-lg border bg-background px-2.5 shadow-xs transition-colors hover:bg-muted/50">
                  <input
                    type="color"
                    aria-label={t("pickColor")}
                    value={previewColor ?? "#18181b"}
                    onChange={(event) => update("primaryColor", event.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                  <span
                    aria-hidden="true"
                    className="size-5 rounded-md border shadow-inner"
                    style={{ backgroundColor: previewColor ?? "#18181b" }}
                  />
                  <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
                    {t("chooseColor")}
                  </span>
                </label>
                {form.primaryColor && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => update("primaryColor", "")}>
                    {t("reset")}
                  </Button>
                )}
              </div>
              {invalidColor ? (
                <p className="text-xs leading-5 text-destructive">{t("invalidHex")}</p>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">{t("emptyAccent")}</p>
              )}
            </div>
          </div>
          </section>

          <div className="flex flex-col gap-4 border-t bg-muted/20 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-6">
            <div className="flex items-center gap-2.5 px-1">
              <span
                className={`size-2 rounded-full ${dirty ? "bg-warning" : "bg-success"}`}
                aria-hidden="true"
              />
              <span className="text-xs font-medium text-muted-foreground">
                {dirty ? t("unsavedChanges") : t("allSaved")}
              </span>
            </div>
            <Button type="submit" disabled={submitting || !dirty || invalidColor} className="w-full min-w-36 sm:w-auto">
              {submitting ? <LoaderCircle className="animate-spin" /> : dirty ? <Save /> : <Check />}
              {submitting ? tc("saving") : dirty ? t("saveChanges") : t("saved")}
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}
