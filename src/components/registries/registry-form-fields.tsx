"use client"

import * as React from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { CredentialGuidance } from "./credential-guidance"
import { isWeakRegistryPassword } from "@/lib/registries/password-security"

export type AuthType = "none" | "basic" | "token"
export type RegistryRoleValue = "MANAGED" | "DELIVERY"

export interface RegistryFormState {
  name: string
  baseUrl: string
  role: RegistryRoleValue
  authType: AuthType
  username: string
  secret: string
  insecureTLS: boolean
  description: string
}

export const emptyRegistryForm: RegistryFormState = {
  name: "",
  baseUrl: "",
  role: "MANAGED",
  authType: "none",
  username: "",
  secret: "",
  insecureTLS: false,
  description: "",
}

export function RegistryFormFields({
  form,
  onChange,
  secretPlaceholder,
  registryId,
}: {
  form: RegistryFormState
  onChange: <K extends keyof RegistryFormState>(key: K, value: RegistryFormState[K]) => void
  secretPlaceholder?: string
  // Present when editing — lets the probe fall back to the stored password so the admin
  // doesn't have to retype it just to run a test.
  registryId?: string
}) {
  const t = useTranslations("registries.form")
  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{t("name")}</Label>
        <Input
          id="name"
          required
          value={form.name}
          onChange={(e) => onChange("name", e.target.value)}
          placeholder={t("namePlaceholder")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="baseUrl">{t("url")}</Label>
        <Input
          id="baseUrl"
          required
          type="url"
          value={form.baseUrl}
          onChange={(e) => onChange("baseUrl", e.target.value)}
          placeholder={t("urlPlaceholder")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("role")}</Label>
        <Select
          value={form.role}
          onValueChange={(v) => onChange("role", v as RegistryRoleValue)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="MANAGED">{t("roleManaged")}</SelectItem>
            <SelectItem value="DELIVERY">{t("roleDelivery")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {form.role === "MANAGED" ? t("roleManagedHint") : t("roleDeliveryHint")}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("auth")}</Label>
        <Select value={form.authType} onValueChange={(v) => onChange("authType", v as AuthType)}>
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {form.authType === "basic" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">{t("username")}</Label>
              <Input
                id="username"
                value={form.username}
                onChange={(e) => onChange("username", e.target.value)}
              />
            </div>
          )}
          <div className={`flex flex-col gap-2 ${form.authType === "token" ? "sm:col-span-2" : ""}`}>
            <Label htmlFor="secret">{form.authType === "basic" ? t("password") : t("token")}</Label>
            <Input
              id="secret"
              type="password"
              value={form.secret}
              onChange={(e) => onChange("secret", e.target.value)}
              placeholder={secretPlaceholder}
            />
          </div>
        </div>
      )}

      {form.authType === "basic" && (
        <CredentialGuidance
          weak={Boolean(form.secret) && isWeakRegistryPassword(form.secret, form.username)}
          dedicated={form.role === "MANAGED"}
        />
      )}

      <div className="flex items-start justify-between gap-4 rounded-md border p-3">
        <div className="min-w-0">
          <Label htmlFor="insecureTLS">{t("insecureTls")}</Label>
          <p className="text-xs text-muted-foreground">{t("insecureTlsHint")}</p>
        </div>
        <Switch
          id="insecureTLS"
          checked={form.insecureTLS}
          onCheckedChange={(v) => onChange("insecureTLS", v)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="description">{t("description")}</Label>
        <Textarea
          id="description"
          value={form.description}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder={t("descriptionPlaceholder")}
        />
      </div>

      <TestConnectionRow form={form} registryId={registryId} />
    </div>
  )
}

type CheckResult = {
  reachable: boolean
  harbor: boolean
  authenticated: boolean
  version: string | null
  error?: string
}

// Same probe the server runs before it accepts the form, surfaced up front so the admin
// sees *which* part is wrong (URL / not a Harbor / credentials) instead of a rejected save.
function TestConnectionRow({
  form,
  registryId,
}: {
  form: RegistryFormState
  registryId?: string
}) {
  const t = useTranslations("registries.form")
  const [testing, setTesting] = React.useState(false)
  const [tested, setTested] = React.useState<{ signature: string; result: CheckResult } | null>(null)

  // A verdict only describes the exact connection it was run against — editing any of
  // those fields makes it stale, which we derive during render rather than clearing in an
  // effect.
  const signature = JSON.stringify([
    form.baseUrl,
    form.authType,
    form.username,
    form.secret,
    form.insecureTLS,
  ])
  const result = tested?.signature === signature ? tested.result : null

  async function runTest() {
    setTesting(true)
    setTested(null)

    const res = await fetch("/api/registries/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
        id: registryId,
        baseUrl: form.baseUrl,
        authType: form.authType,
        username: form.authType !== "none" ? form.username || null : null,
        secret: form.authType !== "none" ? form.secret || null : null,
          insecureTLS: form.insecureTLS,
      }),
    }).catch(() => null)

    setTesting(false)

    if (!res?.ok) {
      setTested({
        signature,
        result: {
          reachable: false,
          harbor: false,
          authenticated: false,
          version: null,
          error: res ? t("checkFailed") : t("gatewayUnreachable"),
        },
      })
      return
    }

    setTested({ signature, result: (await res.json()) as CheckResult })
  }

  const ok = result?.reachable && result.harbor && result.authenticated

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>{t("connection")}</Label>
          <p className="text-xs text-muted-foreground">{t("connectionHint")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={testing || !form.baseUrl}
          onClick={runTest}
        >
          {testing && <Loader2 className="animate-spin" />}
          {testing ? t("testing") : t("testConnection")}
        </Button>
      </div>

      {result && (
        <p
          className={`flex items-start gap-1.5 text-xs ${ok ? "text-success" : "text-destructive"}`}
        >
          {ok ? (
            <CheckCircle2 className="mt-px size-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-px size-3.5 shrink-0" />
          )}
          <span>
            {ok
              ? t("connected", { version: result.version ? ` ${result.version}` : "" })
              : result.error ?? t("connectionFailed")}
          </span>
        </p>
      )}
    </div>
  )
}
