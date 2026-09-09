"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Copy, KeyRound, LoaderCircle, Plus, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { copyToClipboard } from "@/lib/clipboard"
import { formatDateTime } from "@/lib/format-date"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export interface PublicApiToken {
  id: string
  name: string
  tokenPrefix: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

function SecretField({ secret }: { secret: string }) {
  const t = useTranslations("settings.tokens")
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={secret} className="font-mono text-xs" />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={t("copyToken")}
        onClick={() => {
          void copyToClipboard(secret).then((ok) =>
            ok ? toast.success(t("copied")) : toast.error(t("copyFailed")),
          )
        }}
      >
        <Copy />
      </Button>
    </div>
  )
}

type TokenState = "revoked" | "expired" | "active"

function tokenState(token: PublicApiToken): TokenState {
  if (token.revokedAt) return "revoked"
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return "expired"
  return "active"
}

const STATE_VARIANT: Record<TokenState, "secondary" | "outline" | "destructive"> = {
  revoked: "destructive",
  expired: "outline",
  active: "secondary",
}

export function ApiTokensTable({ tokens, maxTtlDays }: { tokens: PublicApiToken[]; maxTtlDays: number }) {
  const t = useTranslations("settings.tokens")
  const tc = useTranslations("common")
  const locale = useLocale()
  const router = useRouter()
  const stateLabel: Record<TokenState, string> = {
    revoked: t("statusRevoked"),
    expired: t("statusExpired"),
    active: t("statusActive"),
  }
  function tokenStatus(token: PublicApiToken) {
    const state = tokenState(token)
    return { state, label: stateLabel[state], variant: STATE_VARIANT[state] }
  }
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const defaultExpiryDays = String(Math.min(90, maxTtlDays))
  const [form, setForm] = React.useState(() => ({ name: "", expiresInDays: defaultExpiryDays }))
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<"all" | "active" | "inactive">("all")
  // Only ever set right after a successful creation — this is the one moment the raw token
  // exists on the client, and it's gone the moment the dialog closes (see toPublicApiToken).
  const [revealed, setRevealed] = React.useState<{ name: string; token: string } | null>(null)
  const [secretStored, setSecretStored] = React.useState(false)
  useUnsavedChanges(Boolean(revealed) && !secretStored)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleTokens = tokens.filter((token) => {
    const status = tokenState(token)
    const matchesQuery =
      !normalizedQuery ||
      token.name.toLowerCase().includes(normalizedQuery) ||
      token.tokenPrefix.toLowerCase().includes(normalizedQuery)
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" ? status === "active" : status !== "active")
    return matchesQuery && matchesStatus
  })

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)

    const expiresAt = form.expiresInDays
      ? new Date(Date.now() + Number(form.expiresInDays) * 24 * 60 * 60 * 1000).toISOString()
      : null

    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, expiresAt }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("createFailed")))
        return
      }

      const created = await res.json()
      setRevealed({ name: created.name, token: created.token })
      setSecretStored(false)
      setForm({ name: "", expiresInDays: defaultExpiryDays })
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(t("createFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(id: string, name: string) {
    setPendingId(id)
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("revokeFailed")))
        return
      }

      toast.success(t("revoked", { name }))
      router.refresh()
    } catch {
      toast.error(t("revokeFailed"))
    } finally {
      setPendingId(null)
    }
  }

  function revokeControl(token: PublicApiToken) {
    if (token.revokedAt) return null
    const busy = pendingId === token.id

    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("revokeAria", { name: token.name })}
            className="rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogMedia className="rounded-xl bg-destructive/10 text-destructive">
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>{t("revokeTitle", { name: token.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("revokeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void handleRevoke(token.id, token.name)}
            >
              {busy ? t("revoking") : t("revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <>
      <div className="flex flex-col items-start justify-between gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:px-8">
        <p className="text-xs leading-5 text-muted-foreground">
          {t("warning")}
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="shrink-0 rounded-lg">
              <Plus />
              {t("create")}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>{t("createTitle")}</DialogTitle>
                <DialogDescription>{t("createDescription")}</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-4 py-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tokenName">{t("name")}</Label>
                  <Input
                    id="tokenName"
                    placeholder={t("namePlaceholder")}
                    required
                    value={form.name}
                    onChange={(event) => update("name", event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="tokenExpiry">{t("expiresIn")}</Label>
                    <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {t("optional")}
                    </span>
                  </div>
                  <Input
                    id="tokenExpiry"
                    type="number"
                    min={1}
                    max={maxTtlDays}
                    placeholder={t("never")}
                    value={form.expiresInDays}
                    onChange={(event) => update("expiresInDays", event.target.value)}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("expiryHint", { defaultDays: defaultExpiryDays, maxDays: maxTtlDays })}
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button type="submit" disabled={submitting || !form.name.trim()} className="min-w-28">
                  {submitting ? <LoaderCircle className="animate-spin" /> : <Plus />}
                  {submitting ? t("creating") : t("create")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {tokens.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-16 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <KeyRound className="size-5" aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm font-semibold">{t("emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <SearchInput
            id="token-search"
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="sm:max-w-xs"
          />
            <div className="flex w-full items-center gap-1 rounded-lg bg-muted p-1 sm:w-auto" aria-label={t("filterAria")}>
              {(["all", "active", "inactive"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={statusFilter === value ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={statusFilter === value}
                  className="flex-1 shadow-none sm:flex-none"
                  onClick={() => setStatusFilter(value)}
                >
                  {value === "all" ? t("filterAll") : value === "active" ? t("filterActive") : t("filterInactive")}
                </Button>
              ))}
            </div>
          </div>

          {visibleTokens.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <Search className="size-5 text-muted-foreground" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">{t("noMatch")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setQuery("")
                  setStatusFilter("all")
                }}
              >
                <X />
                {t("clearFilters")}
              </Button>
            </div>
          ) : (
            <>
              <div className="divide-y sm:hidden">
                {visibleTokens.map((token) => {
                  const status = tokenStatus(token)
                  return (
                    <article key={token.id} className="flex flex-col gap-3 px-5 py-4">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{token.name}</p>
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                            tsk_live_{token.tokenPrefix}…
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge variant={status.variant} className="rounded-md px-2 py-1 text-xs font-semibold">
                            {status.label}
                          </Badge>
                          {revokeControl(token)}
                        </div>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                        <div>
                          <dt className="text-muted-foreground">{t("created")}</dt>
                          <dd className="mt-0.5 font-medium">{formatDateTime(token.createdAt, locale)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("lastUsed")}</dt>
                          <dd className="mt-0.5 font-medium">
                            {token.lastUsedAt ? formatDateTime(token.lastUsedAt, locale) : t("never")}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">{t("expires")}</dt>
                          <dd className="mt-0.5 font-medium">
                            {token.expiresAt ? formatDateTime(token.expiresAt, locale) : t("never")}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  )
                })}
              </div>

              <div className="hidden sm:block">
                <Table className="min-w-[760px]">
          <TableHeader className="bg-muted/30">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 px-5 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase sm:px-6">
                {t("colToken")}
              </TableHead>
              <TableHead className="h-11 px-4 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {t("lastUsed")}
              </TableHead>
              <TableHead className="h-11 px-4 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {t("expires")}
              </TableHead>
              <TableHead className="h-11 px-4 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {t("colStatus")}
              </TableHead>
              <TableHead className="h-11 w-14 px-4">
                <span className="sr-only">{t("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleTokens.map((token) => {
              const status = tokenStatus(token)
              const busy = pendingId === token.id

              return (
                <TableRow
                  key={token.id}
                  data-busy={busy || undefined}
                  className="h-[4.5rem] hover:bg-muted/25 data-[busy=true]:opacity-60"
                >
                  <TableCell className="px-5 py-3 sm:px-6">
                    <div className="min-w-52">
                      <span className="truncate text-sm font-semibold">{token.name}</span>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        tsk_live_{token.tokenPrefix}…
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("createdAt", { date: formatDateTime(token.createdAt, locale) })}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                    {token.lastUsedAt ? formatDateTime(token.lastUsedAt, locale) : t("never")}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                    {token.expiresAt ? formatDateTime(token.expiresAt, locale) : t("never")}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={status.variant} className="rounded-md px-2 py-1 text-xs font-semibold">
                      {status.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    {revokeControl(token)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}

      <Dialog
        open={Boolean(revealed)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && secretStored) setRevealed(null)
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t("revealTitle", { name: revealed?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("revealDescription")}</DialogDescription>
          </DialogHeader>
          <SecretField secret={revealed?.token ?? ""} />
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/30 px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={secretStored}
              onChange={(event) => setSecretStored(event.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>{t("storedConfirm")}</span>
          </label>
          <DialogFooter>
            <Button disabled={!secretStored} onClick={() => setRevealed(null)}>
              {t("done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
