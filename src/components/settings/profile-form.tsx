"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Check,
  ImageUp,
  LoaderCircle,
  Lock,
  Save,
  Trash2,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ACCEPTED_AVATAR_TYPES } from "@/lib/users/avatar"
import type { UserProfile } from "@/lib/users/profile"

export function profileInitials(profile: { name: string | null; username: string }) {
  return (profile.name || profile.username)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function toFormState(profile: UserProfile) {
  return {
    name: profile.name ?? "",
    email: profile.email,
    username: profile.username,
  }
}

export function ProfileForm({
  profile,
  maxAvatarBytes,
}: {
  profile: UserProfile
  maxAvatarBytes: number
}) {
  const t = useTranslations("settings.profileForm")
  const tc = useTranslations("common")
  const router = useRouter()
  const [submitting, setSubmitting] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [form, setForm] = React.useState(() => toFormState(profile))
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const editable = profile.credentialsEditable

  // Re-sync after router.refresh() with the normalized values the server actually stored.
  const saved = toFormState(profile)
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
      if (file.size > maxAvatarBytes) {
        toast.error(t("pictureTooLarge", { kb: Math.round(maxAvatarBytes / 1024) }))
        return
      }

      const body = new FormData()
      body.append("file", file)
      const res = await fetch(`/api/users/${profile.id}/avatar`, { method: "POST", body })

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

  async function handleRemove() {
    setUploading(true)
    try {
      const res = await fetch(`/api/users/${profile.id}/avatar`, { method: "DELETE" })
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
      const res = await fetch("/api/users/me", {
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
      className="overflow-hidden rounded-2xl border bg-card shadow-[0_18px_50px_-38px_oklch(0_0_0/0.35)]"
    >
      <header className="flex items-start gap-3 px-5 py-5 sm:px-6">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
          <UserRound className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("description")}</p>
        </div>
      </header>

      <div className="mx-5 mb-6 flex flex-col gap-4 rounded-xl bg-muted/45 p-4 sm:mx-6 sm:flex-row sm:items-center">
        <Avatar className="size-16 shrink-0 rounded-xl">
          {profile.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="" className="object-cover" />}
          <AvatarFallback className="rounded-xl bg-primary text-base font-semibold text-primary-foreground">
            {profileInitials(profile) || "—"}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("picture")}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("pictureFormats", { kb: Math.round(maxAvatarBytes / 1024) })}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <input
            id="avatarFile"
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_AVATAR_TYPES.join(",")}
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
            {uploading ? <LoaderCircle className="animate-spin" /> : <ImageUp />}
            {uploading ? t("uploading") : profile.avatarUrl ? t("replace") : t("upload")}
          </Button>
          {profile.avatarUrl && !uploading && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("removePicture")}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void handleRemove()}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {!editable && (
        <div className="mx-5 mb-6 flex gap-3 rounded-xl border bg-muted/30 p-3.5 sm:mx-6">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-xs leading-5 text-muted-foreground">
            {t("managedBy", { provider: profile.providerLabel ?? profile.authProvider })}
          </p>
        </div>
      )}

      <div className="grid gap-5 border-t px-5 py-6 sm:grid-cols-2 sm:px-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="profileName">{t("displayName")}</Label>
          <Input
            id="profileName"
            value={form.name}
            onChange={(event) => update("name", event.target.value)}
            maxLength={100}
            disabled={!editable}
            placeholder={profile.username}
            className="h-10"
          />
          <p className="text-xs leading-5 text-muted-foreground">{t("displayNameHint")}</p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="profileUsername">{t("username")}</Label>
          <Input
            id="profileUsername"
            value={form.username}
            onChange={(event) => update("username", event.target.value)}
            minLength={3}
            maxLength={40}
            required
            disabled={!editable}
            className="h-10"
          />
          <p className="text-xs leading-5 text-muted-foreground">{t("usernameHint")}</p>
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="profileEmail">{t("email")}</Label>
          <Input
            id="profileEmail"
            type="email"
            value={form.email}
            onChange={(event) => update("email", event.target.value)}
            maxLength={200}
            required
            disabled={!editable}
            className="h-10"
          />
        </div>
      </div>

      {editable && (
        <div className="flex flex-col gap-4 border-t bg-muted/20 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2.5 px-1">
            <span
              className={`size-2 rounded-full ${dirty ? "bg-warning" : "bg-success"}`}
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-muted-foreground">
              {dirty ? t("unsavedChanges") : t("allSaved")}
            </span>
          </div>
          <Button type="submit" disabled={submitting || !dirty} className="w-full min-w-36 sm:w-auto">
            {submitting ? <LoaderCircle className="animate-spin" /> : dirty ? <Save /> : <Check />}
            {submitting ? tc("saving") : dirty ? t("saveChanges") : t("saved")}
          </Button>
        </div>
      )}
    </form>
  )
}
