"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Settings2 } from "lucide-react"
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
  RegistryFormFields,
  type RegistryFormState,
  type RegistryRoleValue,
} from "@/components/registries/registry-form-fields"

export interface EditableRegistry {
  id: string
  name: string
  baseUrl: string
  authType: "none" | "basic" | "token"
  username: string | null
  role: RegistryRoleValue
  insecureTLS: boolean
  description: string | null
}

export function EditRegistryDialog({ registry }: { registry: EditableRegistry }) {
  const t = useTranslations("registries.edit")
  const tc = useTranslations("common")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [form, setForm] = React.useState<RegistryFormState>({
    name: registry.name,
    baseUrl: registry.baseUrl,
    role: registry.role,
    authType: registry.authType,
    username: registry.username ?? "",
    secret: "",
    insecureTLS: registry.insecureTLS,
    description: registry.description ?? "",
  })

  function update<K extends keyof RegistryFormState>(key: K, value: RegistryFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)

    try {
      const res = await fetch(`/api/registries/${registry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          baseUrl: form.baseUrl,
          role: form.role,
          authType: form.authType,
          username: form.authType !== "none" ? form.username || null : null,
          secret: form.secret || undefined,
          insecureTLS: form.insecureTLS,
          description: form.description || null,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("failed")))
        return
      }

      toast.success(t("updated"))
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
        <Button variant="outline" size="sm">
          <Settings2 />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description", { name: registry.name })}</DialogDescription>
          </DialogHeader>

          <RegistryFormFields
            form={form}
            onChange={update}
            secretPlaceholder={t("secretPlaceholder")}
            registryId={registry.id}
          />

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? tc("saving") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
