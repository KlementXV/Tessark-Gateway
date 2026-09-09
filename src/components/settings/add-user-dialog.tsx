"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Eye, EyeOff, LoaderCircle, Plus, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
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
import { Role } from "@/generated/prisma/client"

const emptyForm = { username: "", email: "", name: "", password: "", role: Role.USER as Role }

export function AddUserDialog() {
  const t = useTranslations("settings.addUser")
  const tRoles = useTranslations("settings.roles")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [form, setForm] = React.useState(emptyForm)

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, name: form.name || null }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }

      toast.success(t("created", { username: form.username }))
      setForm(emptyForm)
      setShowPassword(false)
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
        <Button className="rounded-lg">
          <Plus />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader className="border-b px-7 py-6 pr-14 sm:px-8 sm:py-7">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                <UserPlus className="size-4" aria-hidden="true" />
              </span>
              <div>
                <DialogTitle className="text-base tracking-[-0.02em]">{t("title")}</DialogTitle>
                <DialogDescription className="mt-1 leading-5">{t("description")}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-col gap-6 px-7 py-7 sm:px-8 sm:py-8">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="username">{t("username")}</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  placeholder={t("usernamePlaceholder")}
                  required
                  value={form.username}
                  onChange={(event) => update("username", event.target.value)}
                  className="h-10"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">{t("email")}</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder={t("emailPlaceholder")}
                  required
                  value={form.email}
                  onChange={(event) => update("email", event.target.value)}
                  className="h-10"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="name">{t("displayName")}</Label>
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t("optional")}
                </span>
              </div>
              <Input
                id="name"
                autoComplete="name"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={t("namePlaceholder")}
                className="h-10"
              />
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">{t("temporaryPassword")}</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={form.password}
                    onChange={(event) => update("password", event.target.value)}
                    className="h-10 pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                    aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t("passwordHint")}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="role">{t("role")}</Label>
                <Select value={form.role} onValueChange={(value) => update("role", value as Role)}>
                  <SelectTrigger id="role" className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={Role.USER}>{tRoles("USER")}</SelectItem>
                    <SelectItem value={Role.ADMIN}>{tRoles("ADMIN")}</SelectItem>
                    <SelectItem value={Role.SUPERADMIN}>{tRoles("SUPERADMIN")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">{t("roleHint")}</p>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t bg-muted/20 px-7 py-5 sm:px-8">
            <DialogClose asChild>
              <Button type="button" variant="ghost">{tc("cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={submitting} className="min-w-28">
              {submitting ? <LoaderCircle className="animate-spin" /> : <UserPlus />}
              {submitting ? t("creating") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
