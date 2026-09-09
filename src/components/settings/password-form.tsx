"use client"

import * as React from "react"
import { Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

const MIN_PASSWORD_LENGTH = 8

const EMPTY = { currentPassword: "", newPassword: "", confirmPassword: "" }

function PasswordInput({
  wrapperClassName,
  className,
  ...props
}: React.ComponentProps<typeof Input> & { wrapperClassName?: string }) {
  const t = useTranslations("settings.password")
  const [visible, setVisible] = React.useState(false)

  return (
    <div className={cn("relative", wrapperClassName)}>
      <Input {...props} type={visible ? "text" : "password"} className={cn("pr-10", className)} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
        aria-label={visible ? t("hidePassword") : t("showPassword")}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  )
}

export function PasswordForm() {
  const t = useTranslations("settings.password")
  const [form, setForm] = React.useState(EMPTY)
  const [submitting, setSubmitting] = React.useState(false)

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const tooShort = form.newPassword !== "" && form.newPassword.length < MIN_PASSWORD_LENGTH
  const mismatch = form.confirmPassword !== "" && form.newPassword !== form.confirmPassword
  const complete = form.currentPassword !== "" && form.newPassword !== "" && form.confirmPassword !== ""
  useUnsavedChanges(Object.values(form).some(Boolean) && !submitting)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!complete || tooShort || mismatch) return
    setSubmitting(true)

    try {
      const res = await fetch("/api/users/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("changeFailed")))
        return
      }

      // The session is a JWT minted at login and carries no password material, so it stays
      // valid — nothing to refresh here, just clear the fields.
      toast.success(t("changed"))
      setForm(EMPTY)
    } catch {
      toast.error(t("changeFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)]"
    >
      <header className="flex items-start gap-3 px-5 py-5 sm:px-6">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
          <KeyRound className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("description")}</p>
        </div>
      </header>

      <div className="grid gap-5 border-t px-5 py-6 sm:grid-cols-2 sm:px-6">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="currentPassword">{t("current")}</Label>
          <PasswordInput
            id="currentPassword"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={(event) => update("currentPassword", event.target.value)}
            required
            wrapperClassName="sm:max-w-[calc(50%-0.625rem)]"
            className="h-10"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="newPassword">{t("new")}</Label>
          <PasswordInput
            id="newPassword"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(event) => update("newPassword", event.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
            aria-invalid={tooShort}
            className="h-10"
          />
          <p
            className={`text-xs leading-5 ${tooShort ? "text-destructive" : "text-muted-foreground"}`}
          >
            {t("minLength", { min: MIN_PASSWORD_LENGTH })}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword">{t("confirm")}</Label>
          <PasswordInput
            id="confirmPassword"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(event) => update("confirmPassword", event.target.value)}
            required
            aria-invalid={mismatch}
            className="h-10"
          />
          {mismatch && (
            <p className="text-xs leading-5 text-destructive">{t("mismatch")}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t bg-muted/20 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5 px-1">
          <ShieldCheck className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium text-muted-foreground">
            {t("storedAs")}
          </span>
        </div>
        <Button
          type="submit"
          disabled={submitting || !complete || tooShort || mismatch}
          className="w-full min-w-36 sm:w-auto"
        >
          {submitting ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          {submitting ? t("updating") : t("submit")}
        </Button>
      </div>
    </form>
  )
}
