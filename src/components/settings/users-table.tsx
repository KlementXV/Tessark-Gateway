"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { LoaderCircle, Search, ShieldCheck, Trash2, UserRoundX, X } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { extractErrorMessage } from "@/lib/api-error"
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Role } from "@/generated/prisma/client"

export interface PublicUser {
  id: string
  username: string
  email: string
  name: string | null
  role: Role
  disabled: boolean
  avatarUrl?: string | null
  /** Account mastered by an identity provider — see toPublicUser(). */
  federated?: boolean
}

function userInitials(user: PublicUser) {
  return (user.name || user.username)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function UsersTable({
  users,
  currentUserId,
  providerLabel,
  providerOwnsRoles,
}: {
  users: PublicUser[]
  currentUserId: string
  /** OIDC_DISPLAY_NAME, for naming the directory a federated account belongs to. */
  providerLabel: string
  /**
   * True when a role mapping is configured, in which case the provider re-applies the role at
   * every sign-in and the API refuses to change it here. The control is locked rather than
   * left to fail on submit.
   */
  providerOwnsRoles: boolean
}) {
  const t = useTranslations("settings.users")
  const tRoles = useTranslations("settings.roles")
  const tc = useTranslations("common")
  const router = useRouter()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [pendingChange, setPendingChange] = React.useState<
    | { user: PublicUser; kind: "role"; value: Role }
    | { user: PublicUser; kind: "status"; value: boolean }
    | null
  >(null)

  const normalizedQuery = query.trim().toLowerCase()
  const visibleUsers = users.filter(
    (user) =>
      !normalizedQuery ||
      user.username.toLowerCase().includes(normalizedQuery) ||
      user.email.toLowerCase().includes(normalizedQuery) ||
      user.name?.toLowerCase().includes(normalizedQuery),
  )

  async function patchUser(id: string, data: Record<string, unknown>) {
    setPendingId(id)
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("updateFailed")))
        return false
      }

      toast.success(t("updated"))
      router.refresh()
      return true
    } catch {
      toast.error(t("updateFailed"))
      return false
    } finally {
      setPendingId(null)
    }
  }

  async function handleDelete(id: string, username: string) {
    setPendingId(id)
    try {
      const res = await fetch(`/api/users/${id}`, { method: "DELETE" })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("deleteFailed")))
        return
      }

      toast.success(t("removed", { username }))
      router.refresh()
    } catch {
      toast.error(t("deleteFailed"))
    } finally {
      setPendingId(null)
    }
  }

  async function confirmChange() {
    if (!pendingChange) return
    const data =
      pendingChange.kind === "role"
        ? { role: pendingChange.value }
        : { disabled: pendingChange.value }
    const updated = await patchUser(pendingChange.user.id, data)
    if (updated) setPendingChange(null)
  }

  function roleControl(user: PublicUser, isSelf: boolean, busy: boolean) {
    if (isSelf || (user.federated && providerOwnsRoles)) {
      return (
        <Badge
          variant="secondary"
          className="rounded-md px-2 py-1 text-xs font-semibold"
          title={isSelf ? undefined : t("roleFromProvider", { provider: providerLabel })}
        >
          {tRoles(user.role)}
        </Badge>
      )
    }
    return (
      <Select
        value={user.role}
        disabled={busy}
        onValueChange={(value) =>
          setPendingChange({ user, kind: "role", value: value as Role })
        }
      >
        <SelectTrigger className="w-full border-transparent bg-muted/55 shadow-none hover:bg-muted sm:w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={Role.USER}>{tRoles("USER")}</SelectItem>
          <SelectItem value={Role.ADMIN}>{tRoles("ADMIN")}</SelectItem>
          <SelectItem value={Role.SUPERADMIN}>{tRoles("SUPERADMIN")}</SelectItem>
        </SelectContent>
      </Select>
    )
  }

  function statusControl(user: PublicUser, isSelf: boolean, busy: boolean) {
    return (
      <div className="flex min-w-28 items-center gap-2.5">
        <Switch
          checked={!user.disabled}
          disabled={isSelf || busy}
          aria-label={t("toggleAria", { disabled: String(user.disabled), username: user.username })}
          onCheckedChange={(checked) =>
            setPendingChange({ user, kind: "status", value: !checked })
          }
        />
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {busy ? (
            <>
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              {t("saving")}
            </>
          ) : user.disabled ? (
            t("disabled")
          ) : (
            t("active")
          )}
        </span>
      </div>
    )
  }

  function removeControl(user: PublicUser, isSelf: boolean, busy: boolean) {
    if (isSelf) return null
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("removeAria", { username: user.username })}
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
            <AlertDialogTitle>{t("removeTitle", { username: user.username })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDelete(user.id, user.username)}
            >
              {busy ? t("removing") : t("removeSubmit")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  if (users.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <UserRoundX className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-4 text-sm font-semibold">{t("emptyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("emptyHint")}</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <SearchInput
            id="user-search"
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="sm:max-w-xs"
          />
        <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {t("count", { visible: visibleUsers.length, total: users.length })}
        </p>
      </div>

      {visibleUsers.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <Search className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">{t("noMatch", { query: query.trim() })}</p>
          <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setQuery("")}>
            <X />
            {t("clearSearch")}
          </Button>
        </div>
      ) : (
        <>
          <div className="divide-y sm:hidden">
            {visibleUsers.map((user) => {
              const isSelf = user.id === currentUserId
              const busy = pendingId === user.id
              return (
                <article key={user.id} className="flex flex-col gap-4 px-5 py-4" data-busy={busy || undefined}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-10 rounded-xl">
                      {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" className="object-cover" />}
                      <AvatarFallback className="rounded-xl bg-muted text-xs font-semibold">
                        {userInitials(user)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold">{user.name || user.username}</p>
                        {isSelf && <Badge variant="outline" className="h-5 rounded-md px-1.5 text-xs">{t("you")}</Badge>}
                        {user.federated && (
                          <Badge
                            variant="outline"
                            className="h-5 gap-1 rounded-md px-1.5 text-xs"
                            title={t("federatedHint", { provider: providerLabel })}
                          >
                            <ShieldCheck className="size-3" aria-hidden="true" />
                            {t("federated")}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">@{user.username}</p>
                      <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                    </div>
                    {removeControl(user, isSelf, busy)}
                  </div>
                  <div className="grid grid-cols-2 items-end gap-3">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{t("role")}</span>
                      {roleControl(user, isSelf, busy)}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{t("status")}</span>
                      {statusControl(user, isSelf, busy)}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>

          <div className="hidden sm:block">
            <Table>
      <TableHeader className="bg-muted/30">
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-11 px-5 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase sm:px-6">
            {t("colUser")}
          </TableHead>
          <TableHead className="h-11 px-4 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {t("role")}
          </TableHead>
          <TableHead className="h-11 px-4 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {t("status")}
          </TableHead>
          <TableHead className="h-11 w-14 px-4">
            <span className="sr-only">{t("actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleUsers.map((user) => {
          const isSelf = user.id === currentUserId
          const busy = pendingId === user.id

          return (
            <TableRow
              key={user.id}
              data-busy={busy || undefined}
              className="h-[4.5rem] hover:bg-muted/25 data-[busy=true]:opacity-60"
            >
              <TableCell className="px-5 py-3 sm:px-6">
                <div className="flex min-w-52 items-center gap-3">
                  <Avatar className="size-9 rounded-xl">
                    {user.avatarUrl && (
                      <AvatarImage src={user.avatarUrl} alt="" className="object-cover" />
                    )}
                    <AvatarFallback className="rounded-xl bg-muted text-xs font-semibold text-foreground">
                      {userInitials(user)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{user.name || user.username}</span>
                      {isSelf && (
                        <Badge variant="outline" className="rounded-md px-1.5 py-0 text-xs tracking-wide uppercase">
                          {t("you")}
                        </Badge>
                      )}
                      {user.federated && (
                        <Badge
                          variant="outline"
                          className="gap-1 rounded-md px-1.5 py-0 text-xs"
                          title={t("federatedHint", { provider: providerLabel })}
                        >
                          <ShieldCheck className="size-3" aria-hidden="true" />
                          {t("federated")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      @{user.username} · {user.email}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="px-4 py-3">
                {roleControl(user, isSelf, busy)}
              </TableCell>
              <TableCell className="px-4 py-3">
                {statusControl(user, isSelf, busy)}
              </TableCell>
              <TableCell className="px-4 py-3 text-right">
                {removeControl(user, isSelf, busy)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
            </Table>
          </div>
        </>
      )}

      <AlertDialog open={Boolean(pendingChange)} onOpenChange={(open) => !open && setPendingChange(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingChange?.kind === "role"
                ? t("changeRoleTitle", { username: pendingChange.user.username })
                : t("toggleTitle", { disabled: String(Boolean(pendingChange?.value)), username: pendingChange?.user.username ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange?.kind === "role"
                ? t("changeRoleDescription", { role: tRoles(pendingChange.value) })
                : pendingChange?.value
                  ? t("disableDescription")
                  : t("enableDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingId === pendingChange?.user.id}
              onClick={() => void confirmChange()}
            >
              {pendingId === pendingChange?.user.id ? tc("saving") : t("confirmChange")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
