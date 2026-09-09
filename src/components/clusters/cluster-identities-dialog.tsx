"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Trash2, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { HarborAccountPicker } from "@/components/clusters/harbor-account-picker"
import { UserPicker, type DirectoryUser } from "@/components/users/user-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { extractErrorMessage } from "@/lib/api-error"

// Who is who on a cluster that keeps its own user directory.
//
// Every write here moves real grants: the API revokes under the old account before granting
// under the new one, so a correction made in this table reaches the Harbors instead of only
// changing what the Gateway believes.

interface Identity {
  id: string
  userId: string
  harborUsername: string
  user: { id: string; username: string; name: string | null; email: string }
  /** Whether the cluster's directory still holds this account. Absent when not verified. */
  known?: boolean | null
}

export function ClusterIdentitiesDialog({
  clusterId,
  clusterName,
  trigger,
}: {
  clusterId: string
  clusterName: string
  trigger: React.ReactNode
}) {
  const t = useTranslations("clusters.identities")
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [identities, setIdentities] = React.useState<Identity[] | null>(null)
  const [selectedUser, setSelectedUser] = React.useState<DirectoryUser | null>(null)
  const [account, setAccount] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/clusters/${clusterId}/identities?verify=1`)
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(extractErrorMessage(body, t("loadFailed")))
      setIdentities(body.identities ?? [])
    } catch (err) {
      setIdentities([])
      toast.error(err instanceof Error ? err.message : t("loadFailed"))
    }
  }, [clusterId, t])

  async function handleSave() {
    if (!selectedUser || !account) return
    setBusy("add")
    try {
      const res = await fetch(`/api/clusters/${clusterId}/identities`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUser.id, harborUsername: account }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("saveFailed")))
        return
      }
      // The grants that followed the old mapping have just moved — say so, because the person
      // whose access changed is not the one looking at this screen.
      toast.success(t("saved"), {
        description: body?.projects
          ? t("savedDetail", { projects: body.projects })
          : undefined,
      })
      setSelectedUser(null)
      setAccount(null)
      await load()
      router.refresh()
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(identity: Identity) {
    setBusy(identity.id)
    try {
      const res = await fetch(`/api/clusters/${clusterId}/identities/${identity.userId}`, {
        method: "DELETE",
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("deleteFailed")))
        return
      }
      toast.success(t("deleted"), {
        description: body?.projects ? t("deletedDetail", { projects: body.projects }) : undefined,
      })
      await load()
      router.refresh()
    } catch {
      toast.error(t("deleteFailed"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      // Loaded on open rather than from an effect: the list is a snapshot of a remote state,
      // and opening the dialog is the event that asks for a fresh one.
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load()
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title", { cluster: clusterName })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-y py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="identity-user">{t("user")}</Label>
            <UserPicker
              id="identity-user"
              value={selectedUser}
              onChange={setSelectedUser}
              disabled={busy !== null}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="identity-account">{t("account")}</Label>
            <HarborAccountPicker
              id="identity-account"
              clusterId={clusterId}
              value={account}
              onChange={setAccount}
              disabled={!selectedUser || busy !== null}
            />
          </div>
          <Button
            type="button"
            className="w-full md:w-auto"
            disabled={!selectedUser || !account || busy !== null}
            onClick={() => void handleSave()}
          >
            {busy === "add" ? <Loader2 className="animate-spin" /> : <UserPlus />}
            {t("save")}
          </Button>
        </div>

        {identities === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("loading")}</p>
        ) : identities.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("user")}</TableHead>
                  <TableHead>{t("account")}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">{t("actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {identities.map((identity) => (
                  <TableRow key={identity.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {identity.user.name || identity.user.username}
                        </span>
                        {identity.user.name && (
                          <span className="text-xs text-muted-foreground">
                            {identity.user.username}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {identity.harborUsername}
                      {identity.known === false && (
                        <span
                          className="ml-2 font-sans text-xs text-warning"
                          title={t("unknownAccountHint")}
                        >
                          {t("unknownAccount")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy !== null}
                        aria-label={t("deleteAria", { account: identity.harborUsername })}
                        onClick={() => void handleDelete(identity)}
                      >
                        {busy === identity.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Trash2 className="text-destructive" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
