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
import {
  emptyRegistryForm,
  RegistryFormFields,
  type RegistryFormState,
} from "@/components/registries/registry-form-fields"

export function AddRegistryDialog() {
  const t = useTranslations("registries.add")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [form, setForm] = React.useState(emptyRegistryForm)

  function update<K extends keyof RegistryFormState>(key: K, value: RegistryFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch("/api/registries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          baseUrl: form.baseUrl,
          role: form.role,
          authType: form.authType,
          username: form.authType !== "none" ? form.username || null : null,
          secret: form.authType !== "none" ? form.secret || null : null,
          insecureTLS: form.insecureTLS,
          description: form.description || null,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }

      toast.success(t("added", { name: form.name }))
      setForm(emptyRegistryForm)
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
        <Button>
          <Plus />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <RegistryFormFields form={form} onChange={update} />

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("pending") : t("trigger")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
