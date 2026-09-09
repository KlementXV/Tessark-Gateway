"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, LayoutTemplate, List, LoaderCircle, Plus, RotateCcw, Save, Trash2, Type } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  LOGIN_FEATURE_DESCRIPTION_MAX,
  LOGIN_FEATURE_TITLE_MAX,
  LOGIN_TEXT_MAX,
  MAX_LOGIN_FEATURES,
  type LoginContent,
  type LoginFeature,
} from "@/lib/settings/login-content"

/** The translated copy the login page falls back to, resolved server-side. */
export interface LoginContentDefaults {
  description: string
  heroTitle: string
  heroSubtitle: string
  footnote: string
  features: LoginFeature[]
}

type FormState = {
  description: string
  heroTitle: string
  heroSubtitle: string
  footnote: string
  /** null = the built-in list; an array (possibly empty) = an explicit override. */
  features: LoginFeature[] | null
}

function toFormState(content: LoginContent): FormState {
  return {
    description: content.description ?? "",
    heroTitle: content.heroTitle ?? "",
    heroSubtitle: content.heroSubtitle ?? "",
    footnote: content.footnote ?? "",
    features: content.features,
  }
}

function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Type
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

export function LoginContentForm({
  content,
  defaults,
  brandTitle,
}: {
  content: LoginContent
  defaults: LoginContentDefaults
  brandTitle: string
}) {
  const t = useTranslations("settings.loginPage")
  const tc = useTranslations("common")
  const router = useRouter()
  const [submitting, setSubmitting] = React.useState(false)
  const [form, setForm] = React.useState(() => toFormState(content))

  // Re-sync after router.refresh() with what the server actually stored.
  const saved = toFormState(content)
  const savedKey = JSON.stringify(saved)
  const [lastSavedKey, setLastSavedKey] = React.useState(savedKey)
  if (savedKey !== lastSavedKey) {
    setLastSavedKey(savedKey)
    setForm(saved)
  }

  const dirty = savedKey !== JSON.stringify(form)
  useUnsavedChanges(dirty && !submitting)

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function updateFeature(index: number, patch: Partial<LoginFeature>) {
    setForm((current) => {
      const features = current.features ?? defaults.features
      return {
        ...current,
        features: features.map((feature, i) => (i === index ? { ...feature, ...patch } : feature)),
      }
    })
  }

  function addFeature() {
    setForm((current) => {
      const features = current.features ?? defaults.features
      if (features.length >= MAX_LOGIN_FEATURES) return current
      return { ...current, features: [...features, { title: "", description: "" }] }
    })
  }

  function removeFeature(index: number) {
    setForm((current) => {
      const features = current.features ?? defaults.features
      return { ...current, features: features.filter((_, i) => i !== index) }
    })
  }

  const editedFeatures = form.features ?? defaults.features
  const usingDefaultFeatures = form.features === null
  const invalidFeature = editedFeatures.some((feature) => !feature.title.trim())

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch("/api/settings/login", {
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

  return (
    <form
      onSubmit={handleSubmit}
      className="animate-enter"
    >
      <div className="min-w-0">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)]">
          <section>
            <SectionHeading icon={LayoutTemplate} title={t("hero")} description={t("heroHint")} />
            <div className="flex flex-col gap-6 px-6 pt-6 pb-8 sm:px-8 sm:pt-7 sm:pb-9">
              <div className="flex flex-col gap-2">
                <Label htmlFor="heroTitle">{t("heroTitle")}</Label>
                <Input
                  id="heroTitle"
                  value={form.heroTitle}
                  onChange={(event) => update("heroTitle", event.target.value)}
                  maxLength={LOGIN_TEXT_MAX}
                  placeholder={defaults.heroTitle}
                  className="h-10"
                />
                <p className="text-xs leading-5 text-muted-foreground">{t("heroTitleHint")}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="heroSubtitle">{t("heroSubtitle")}</Label>
                <Textarea
                  id="heroSubtitle"
                  value={form.heroSubtitle}
                  onChange={(event) => update("heroSubtitle", event.target.value)}
                  maxLength={LOGIN_TEXT_MAX}
                  placeholder={defaults.heroSubtitle}
                  rows={3}
                />
                <p className="text-xs leading-5 text-muted-foreground">{t("heroSubtitleHint")}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="footnote">{t("footnote")}</Label>
                <Input
                  id="footnote"
                  value={form.footnote}
                  onChange={(event) => update("footnote", event.target.value)}
                  maxLength={LOGIN_TEXT_MAX}
                  placeholder={defaults.footnote}
                  className="h-10"
                />
                <p className="text-xs leading-5 text-muted-foreground">{t("footnoteHint")}</p>
              </div>
            </div>
          </section>

          <section className="border-t">
            <SectionHeading icon={Type} title={t("form")} description={t("formHint")} />
            <div className="px-6 pt-6 pb-8 sm:px-8 sm:pt-7 sm:pb-9">
              <div className="flex flex-col gap-2">
                <Label htmlFor="description">{t("description")}</Label>
                <Input
                  id="description"
                  value={form.description}
                  onChange={(event) => update("description", event.target.value)}
                  maxLength={LOGIN_TEXT_MAX}
                  placeholder={defaults.description}
                  className="h-10"
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("descriptionHint", { title: brandTitle })}
                </p>
              </div>
            </div>
          </section>

          <section className="border-t">
            <SectionHeading
              icon={List}
              title={t("features")}
              description={t("featuresHint", { max: MAX_LOGIN_FEATURES })}
            />
            <div className="flex flex-col gap-4 px-6 pt-6 pb-8 sm:px-8 sm:pt-7 sm:pb-9">
              {usingDefaultFeatures && (
                <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground">
                  {t("featuresDefaultNotice")}
                </p>
              )}

              {editedFeatures.map((feature, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-3 rounded-xl border bg-muted/15 p-4 sm:flex-row sm:items-start"
                >
                  <span className="mt-2 hidden size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground sm:flex">
                    {index + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`feature-title-${index}`} className="text-xs text-muted-foreground">
                        {t("featureTitle")}
                      </Label>
                      <Input
                        id={`feature-title-${index}`}
                        value={feature.title}
                        onChange={(event) => updateFeature(index, { title: event.target.value })}
                        maxLength={LOGIN_FEATURE_TITLE_MAX}
                        aria-invalid={!feature.title.trim()}
                        className="h-10"
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label
                        htmlFor={`feature-description-${index}`}
                        className="text-xs text-muted-foreground"
                      >
                        {t("featureDescription")}
                      </Label>
                      <Textarea
                        id={`feature-description-${index}`}
                        value={feature.description}
                        onChange={(event) => updateFeature(index, { description: event.target.value })}
                        maxLength={LOGIN_FEATURE_DESCRIPTION_MAX}
                        rows={2}
                      />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("removeFeature", { index: index + 1 })}
                    className="shrink-0 self-end text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:self-start"
                    onClick={() => removeFeature(index)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}

              {editedFeatures.length === 0 && !usingDefaultFeatures && (
                <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground">
                  {t("featuresEmpty")}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={editedFeatures.length >= MAX_LOGIN_FEATURES}
                  onClick={addFeature}
                >
                  <Plus />
                  {t("addFeature")}
                </Button>
                {!usingDefaultFeatures && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => update("features", null)}
                  >
                    <RotateCcw />
                    {t("restoreDefaults")}
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  {t("featureCount", { count: editedFeatures.length, max: MAX_LOGIN_FEATURES })}
                </span>
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
            <Button
              type="submit"
              disabled={submitting || !dirty || invalidFeature}
              className="w-full min-w-36 sm:w-auto"
            >
              {submitting ? <LoaderCircle className="animate-spin" /> : dirty ? <Save /> : <Check />}
              {submitting ? tc("saving") : dirty ? t("saveChanges") : t("saved")}
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}
