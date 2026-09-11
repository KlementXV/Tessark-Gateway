"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

// The opt-in LDAP configuration of a cluster's Harbors (src/lib/clusters/directory-config.ts).
// Two steps on purpose, kept visibly apart: *saving* stores settings in the Gateway and touches no
// Harbor; *applying* writes them, Harbor by Harbor, each one testing them first. The apply half
// names its blast radius and the local `admin` fallback before it can be pressed.

interface FormValues {
  enabled: boolean
  url: string
  searchDn: string
  baseDn: string
  filter: string
  uid: string
  scope: number
  verifyCert: boolean
  groupBaseDn: string
  groupSearchFilter: string
  groupAttributeName: string
  groupMembershipAttribute: string
  groupSearchScope: number
}

interface MemberState {
  registryId: string
  registryName: string
  appliedAt: string | null
  state: "in-sync" | "differs" | "never-applied"
}

type Outcome = { registryId: string; registryName: string } & (
  | { status: "unchanged" }
  | { status: "applied"; written: boolean; authMode: "not-requested" | "already" | "switched" | "locked" }
  | { status: "ping-failed"; message: string | null }
  | { status: "failed"; error: string }
)

const EMPTY: FormValues = {
  enabled: false,
  url: "",
  searchDn: "",
  baseDn: "",
  filter: "",
  uid: "uid",
  scope: 2,
  verifyCert: true,
  groupBaseDn: "",
  groupSearchFilter: "",
  groupAttributeName: "cn",
  groupMembershipAttribute: "memberof",
  groupSearchScope: 2,
}

function errorOf(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === "string" ? error : fallback
}

export function ClusterDirectoryConfigDialog({
  clusterId,
  clusterName,
  trigger,
}: {
  clusterId: string
  clusterName: string
  trigger: React.ReactNode
}) {
  const t = useTranslations("clusters.directoryConfig")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState<FormValues>(EMPTY)
  const [password, setPassword] = React.useState("")
  const [stored, setStored] = React.useState<{ enabled: boolean; hasPassword: boolean } | null>(null)
  const [members, setMembers] = React.useState<MemberState[]>([])
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const [force, setForce] = React.useState(false)
  const [setAuthMode, setSetAuthMode] = React.useState(false)
  const [confirmed, setConfirmed] = React.useState(false)
  const [results, setResults] = React.useState<Outcome[] | null>(null)

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/clusters/${clusterId}/directory-config`)
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setLoadError(errorOf(body, t("loadFailed")))
        return
      }
      setMembers(body.members ?? [])
      if (body.config) {
        // Only the form's own keys are taken: the response also carries what must not be sent back.
        const values = Object.fromEntries(
          Object.entries(EMPTY).map(([key, fallback]) => [key, body.config[key] ?? fallback])
        ) as unknown as FormValues
        setForm(values)
        setStored({ enabled: body.config.enabled, hasPassword: Boolean(body.config.hasSearchPassword) })
      } else {
        setForm(EMPTY)
        setStored(null)
      }
    } catch {
      setLoadError(t("loadFailed"))
    }
  }, [clusterId, t])

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(`/api/clusters/${clusterId}/directory-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // An empty field keeps the stored password: it is never sent back to be shown.
        body: JSON.stringify({ ...form, ...(password ? { searchPassword: password } : {}) }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(errorOf(body, t("saveFailed")))
        return
      }
      setPassword("")
      toast.success(t("saved"))
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    const res = await fetch(`/api/clusters/${clusterId}/directory-config`, { method: "DELETE" })
    if (!res.ok) {
      toast.error(t("saveFailed"))
      return
    }
    toast.success(t("removed"))
    setResults(null)
    await load()
  }

  async function apply() {
    setApplying(true)
    setResults(null)
    try {
      const res = await fetch(`/api/clusters/${clusterId}/directory-config/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, setAuthMode, confirm: true }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(errorOf(body, t("applyFailed")))
        return
      }
      setResults(body.results ?? [])
      setConfirmed(false)
      await load()
      router.refresh()
    } finally {
      setApplying(false)
    }
  }

  const outcomeText = (outcome: Outcome) => {
    switch (outcome.status) {
      case "unchanged":
        return t("outcomeUnchanged")
      case "ping-failed":
        return t("outcomePingFailed", { message: outcome.message ?? "—" })
      case "failed":
        return t("outcomeFailed", { error: outcome.error })
      case "applied": {
        const base = outcome.written ? t("outcomeWritten") : t("outcomeNotWritten")
        const mode =
          outcome.authMode === "switched"
            ? t("authModeSwitched")
            : outcome.authMode === "already"
              ? t("authModeAlready")
              : outcome.authMode === "locked"
                ? t("authModeLocked")
                : null
        return mode ? `${base} · ${mode}` : base
      }
    }
  }

  const canApply = Boolean(stored?.enabled && stored.hasPassword)
  const scopeItems = (
    <SelectContent>
      <SelectItem value="0">{t("scopeBase")}</SelectItem>
      <SelectItem value="1">{t("scopeOne")}</SelectItem>
      <SelectItem value="2">{t("scopeSub")}</SelectItem>
    </SelectContent>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setResults(null)
          setConfirmed(false)
          void load()
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title", { cluster: clusterName })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="ldap-enabled">{t("enabled")}</Label>
              <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
            </div>
            <Switch id="ldap-enabled" checked={form.enabled} onCheckedChange={(value) => update("enabled", value)} />
          </div>

          <p className="text-sm font-medium">{t("sectionUsers")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="ldap-url">{t("url")}</Label>
              <Input id="ldap-url" value={form.url} onChange={(e) => update("url", e.target.value)} placeholder="ldaps://dc01.example.com:636" required />
              <p className="text-xs text-muted-foreground">{t("urlHint")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-search-dn">{t("searchDn")}</Label>
              <Input id="ldap-search-dn" value={form.searchDn} onChange={(e) => update("searchDn", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-password">{t("searchPassword")}</Label>
              <Input
                id="ldap-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={stored?.hasPassword ? t("searchPasswordKeep") : ""}
              />
              <p className="text-xs text-muted-foreground">{t("searchPasswordHint")}</p>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="ldap-base-dn">{t("baseDn")}</Label>
              <Input id="ldap-base-dn" value={form.baseDn} onChange={(e) => update("baseDn", e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-filter">{t("filter")}</Label>
              <Input id="ldap-filter" value={form.filter} onChange={(e) => update("filter", e.target.value)} placeholder="(objectClass=person)" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-uid">{t("uid")}</Label>
              <Input id="ldap-uid" value={form.uid} onChange={(e) => update("uid", e.target.value)} required />
              <p className="text-xs text-muted-foreground">{t("uidHint")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-scope">{t("scope")}</Label>
              <Select value={String(form.scope)} onValueChange={(value) => update("scope", Number(value))}>
                <SelectTrigger id="ldap-scope"><SelectValue /></SelectTrigger>
                {scopeItems}
              </Select>
            </div>
            <div className="flex items-center gap-2 self-end pb-2">
              <Checkbox id="ldap-verify" checked={form.verifyCert} onCheckedChange={(value) => update("verifyCert", value === true)} />
              <Label htmlFor="ldap-verify">{t("verifyCert")}</Label>
            </div>
          </div>

          <p className="text-sm font-medium">{t("sectionGroups")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="ldap-group-base-dn">{t("groupBaseDn")}</Label>
              <Input id="ldap-group-base-dn" value={form.groupBaseDn} onChange={(e) => update("groupBaseDn", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-group-filter">{t("groupSearchFilter")}</Label>
              <Input id="ldap-group-filter" value={form.groupSearchFilter} onChange={(e) => update("groupSearchFilter", e.target.value)} placeholder="objectclass=group" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-group-scope">{t("scope")}</Label>
              <Select value={String(form.groupSearchScope)} onValueChange={(value) => update("groupSearchScope", Number(value))}>
                <SelectTrigger id="ldap-group-scope"><SelectValue /></SelectTrigger>
                {scopeItems}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-group-attr">{t("groupAttributeName")}</Label>
              <Input id="ldap-group-attr" value={form.groupAttributeName} onChange={(e) => update("groupAttributeName", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ldap-group-membership">{t("groupMembershipAttribute")}</Label>
              <Input id="ldap-group-membership" value={form.groupMembershipAttribute} onChange={(e) => update("groupMembershipAttribute", e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {stored ? (
              <Button type="button" variant="ghost" onClick={() => void remove()} title={t("removeHint")}>
                {t("remove")}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={saving}>
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">{t("applyTitle")}</p>

          {members.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-xs text-muted-foreground">{t("membersTitle")}</p>
              {members.map((member) => {
                const outcome = results?.find((entry) => entry.registryId === member.registryId)
                return (
                  <div key={member.registryId} className="flex flex-wrap justify-between gap-x-3">
                    <span className="font-medium">{member.registryName}</span>
                    <span className="text-muted-foreground">
                      {outcome
                        ? outcomeText(outcome)
                        : member.state === "in-sync"
                          ? t("stateInSync")
                          : member.state === "differs"
                            ? t("stateDiffers")
                            : t("stateNeverApplied")}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex flex-col gap-1">
              <p>{t("applyWarning")}</p>
              <p className="text-muted-foreground">{t("applyPing")}</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox id="ldap-force" checked={force} onCheckedChange={(value) => setForce(value === true)} />
            <div className="flex flex-col">
              <Label htmlFor="ldap-force">{t("force")}</Label>
              <p className="text-xs text-muted-foreground">{t("forceHint")}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="ldap-auth-mode" checked={setAuthMode} onCheckedChange={(value) => setSetAuthMode(value === true)} />
            <div className="flex flex-col">
              <Label htmlFor="ldap-auth-mode">{t("setAuthMode")}</Label>
              <p className="text-xs text-muted-foreground">{t("setAuthModeHint")}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="ldap-confirm" checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
            <Label htmlFor="ldap-confirm">{t("confirm")}</Label>
          </div>

          {!canApply && (
            <p className="text-xs text-muted-foreground">
              {stored?.enabled ? t("applyNeedsPassword") : t("applyDisabled")}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="button" variant="destructive" disabled={!canApply || !confirmed || applying} onClick={() => void apply()}>
              {applying ? t("applying") : t("apply", { count: members.length })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
