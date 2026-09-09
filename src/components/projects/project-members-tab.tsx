"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2, UserPlus, Users, UsersRound } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { HarborAccountPicker } from "@/components/clusters/harbor-account-picker"
import { ProjectGroupPicker } from "@/components/projects/project-group-picker"
import { UserPicker, type DirectoryUser } from "@/components/users/user-picker"
import { ProjectMemberRole } from "@/generated/prisma/client"
import { extractErrorMessage } from "@/lib/api-error"
import { cn } from "@/lib/utils"

interface Member {
  id: string
  userId: string
  role: ProjectMemberRole
  /** Resolved server-side — the directory endpoint is a search, not a full listing. */
  username: string | null
  name: string | null
  /** The account this person holds in the cluster's directory, when it keeps one. */
  harborUsername: string | null
}

/** A directory group granted a role on this project — see ProjectGroupMember. */
interface GroupMember {
  id: string
  groupName: string
  role: ProjectMemberRole
}

/** Per-Harbor outcome of the membership fan-out, as the members API reports it. */
interface Placements {
  succeeded: number
  failed: number
  failures: Array<{ registry: string; error: string }>
}

type MembersT = ReturnType<typeof useTranslations<"projects.members">>

function roleLabel(role: ProjectMemberRole, t: MembersT) {
  if (role === ProjectMemberRole.PROJECT_ADMIN) return t("roleProjectAdmin")
  if (role === ProjectMemberRole.DEVELOPER) return t("roleDeveloper")
  return t("roleGuest")
}

// The toast line under "Member added"/"Member removed". Silent on a clean fan-out — there is
// nothing to say when every Harbor took it — and names the ones that didn't otherwise.
function placementDetail(placements: Placements | null | undefined, t: MembersT) {
  if (!placements || placements.failed === 0) return undefined
  const detail = placements.failures.map((f) => `${f.registry}: ${f.error}`).join("; ")
  return t("notApplied", {
    failed: placements.failed,
    total: placements.succeeded + placements.failed,
    detail,
  })
}

export function ProjectMembersTab({
  projectId,
  clusterId,
  // MAPPED means this cluster answers to a directory of its own, so a membership has to name
  // the account *that* directory knows — see ClusterIdentityMode in the Prisma schema.
  identityMode,
  members,
  groups,
  ownerUserId,
  isManager,
  // Writing a mapping is cluster-wide and decides which real account receives a grant, so it
  // stays an ADMIN's call: a project manager who is not one adds people who are already
  // mapped, and is told to ask otherwise (the server answers 409 either way).
  isAdmin,
}: {
  projectId: string
  clusterId: string
  identityMode: "GATEWAY" | "MAPPED"
  members: Member[]
  groups: GroupMember[]
  ownerUserId: string | null
  isManager: boolean
  isAdmin: boolean
}) {
  const t = useTranslations("projects.members")
  const tg = useTranslations("projects.groups")
  const tc = useTranslations("common")
  const router = useRouter()
  const [selectedUser, setSelectedUser] = React.useState<DirectoryUser | null>(null)
  const [selectedRole, setSelectedRole] = React.useState<ProjectMemberRole>(ProjectMemberRole.DEVELOPER)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [harborAccount, setHarborAccount] = React.useState<string | null>(null)
  // What the picked person is already called on this cluster: `undefined` while it is being
  // looked up, `null` once we know there is nothing mapped. Read per selection rather than
  // shipped with the page — the picker offers people who are not members yet, so their
  // mapping is not among the ones the members list carries.
  const [mapped, setMapped] = React.useState<string | null | undefined>(undefined)

  const asksForAccount = identityMode === "MAPPED" && isAdmin

  // Picking somebody else invalidates both the lookup and whatever account was chosen for the
  // previous person — reset here rather than in the effect, so nothing is ever submitted
  // against the wrong user.
  function pickUser(user: DirectoryUser | null) {
    setSelectedUser(user)
    setMapped(undefined)
    setHarborAccount(null)
  }

  React.useEffect(() => {
    if (!asksForAccount || !selectedUser) return
    let active = true
    void (async () => {
      try {
        const res = await fetch(
          `/api/clusters/${clusterId}/identities?userId=${encodeURIComponent(selectedUser.id)}`
        )
        const body = await res.json().catch(() => null)
        if (!active) return
        setMapped(res.ok ? (body?.identities?.[0]?.harborUsername ?? null) : null)
      } catch {
        if (active) setMapped(null)
      }
    })()
    return () => {
      active = false
    }
  }, [asksForAccount, selectedUser, clusterId])

  const needsAccount = asksForAccount && mapped === null
  // Nothing to add until the grant can name somebody on the cluster's Harbors. A non-admin
  // manager is never blocked here: they cannot map anyone anyway, and the server tells them
  // whether the person is mapped already.
  const addDisabled = !selectedUser || busyId !== null || (needsAccount && !harborAccount)

  // Already granted, so not offered again: the owner plus everyone currently a member.
  const excludedUserIds = React.useMemo(
    () => [...members.map((member) => member.userId), ...(ownerUserId ? [ownerUserId] : [])],
    [members, ownerUserId]
  )

  const [selectedGroup, setSelectedGroup] = React.useState<string | null>(null)
  const [selectedGroupRole, setSelectedGroupRole] = React.useState<ProjectMemberRole>(
    ProjectMemberRole.DEVELOPER
  )

  async function handleAddGroup() {
    if (!selectedGroup) return
    setBusyId("add-group")
    try {
      const res = await fetch(`/api/projects/${projectId}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupName: selectedGroup, role: selectedGroupRole }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, tg("addFailed")))
        return
      }
      toast.success(tg("added"), { description: placementDetail(body?.placements, t) })
      setSelectedGroup(null)
      router.refresh()
    } catch {
      toast.error(tg("addFailed"))
    } finally {
      setBusyId(null)
    }
  }

  async function handleRemoveGroup(groupName: string) {
    setBusyId(`group:${groupName}`)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/groups/${encodeURIComponent(groupName)}`,
        { method: "DELETE" }
      )
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, tg("removeFailed")))
        return
      }
      toast.success(tg("removed"), { description: placementDetail(body?.placements, t) })
      router.refresh()
    } catch {
      toast.error(tg("removeFailed"))
    } finally {
      setBusyId(null)
    }
  }

  async function handleAdd() {
    if (!selectedUser) return
    setBusyId("add")
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selectedUser.id,
          role: selectedRole,
          // Sent only when there is nothing mapped yet: an existing mapping is the cluster's
          // answer already, and re-sending it would move grants for no reason.
          ...(needsAccount && harborAccount ? { harborUsername: harborAccount } : {}),
        }),
      })

      const body = await res.json().catch(() => null)

      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("addFailed")))
        return
      }

      // The grant only means anything once Harbor holds it, so a partial fan-out is surfaced
      // rather than reported as a clean success — the missing Harbors are retried by the
      // reconciler, but until then the user's access there is not what the table shows.
      toast.success(t("added"), { description: placementDetail(body?.placements, t) })
      pickUser(null)
      router.refresh()
    } catch {
      toast.error(t("addFailed"))
    } finally {
      setBusyId(null)
    }
  }

  async function handleRemove(userId: string) {
    setBusyId(userId)
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
        method: "DELETE",
      })

      const body = await res.json().catch(() => null)

      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("removeFailed")))
        return
      }

      toast.success(t("removed"), { description: placementDetail(body?.placements, t) })
      router.refresh()
    } catch {
      toast.error(t("removeFailed"))
    } finally {
      setBusyId(null)
    }
  }

  function removeMemberButton(member: Member, isOwner: boolean) {
    if (!isManager || isOwner) return null
    const displayName = member.name || member.username || t("memberFallback")

    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busyId !== null}
            aria-label={t("removeAria", { name: displayName })}
          >
            <Trash2 className="text-destructive" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle", { name: displayName })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyId === member.userId}
              onClick={() => void handleRemove(member.userId)}
            >
              {busyId === member.userId ? t("removing") : t("removeSubmit")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {isManager && (
        <div
          className={cn(
            "grid gap-3 border-y py-4 md:items-end",
            identityMode === "MAPPED"
              ? "md:grid-cols-[minmax(0,16rem)_minmax(0,16rem)_10rem_auto]"
              : "md:grid-cols-[minmax(0,20rem)_10rem_auto]"
          )}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="member-user">{t("user")}</Label>
            <UserPicker
              id="member-user"
              value={selectedUser}
              onChange={pickUser}
              excludeUserIds={excludedUserIds}
              disabled={busyId !== null}
            />
          </div>

          {identityMode === "MAPPED" && (
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="member-harbor-account">{t("harborAccount")}</Label>
              {!isAdmin ? (
                <p className="text-sm text-muted-foreground">{t("harborAccountNeeded")}</p>
              ) : mapped ? (
                <p className="flex h-9 items-center truncate text-sm text-muted-foreground">
                  {t("harborAccountMapped", { account: mapped })}
                </p>
              ) : (
                <HarborAccountPicker
                  id="member-harbor-account"
                  clusterId={clusterId}
                  value={harborAccount}
                  onChange={setHarborAccount}
                  disabled={!selectedUser || busyId !== null}
                />
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="member-role">{t("role")}</Label>
            <Select
              value={selectedRole}
              onValueChange={(value) => setSelectedRole(value as ProjectMemberRole)}
            >
              <SelectTrigger id="member-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ProjectMemberRole.PROJECT_ADMIN}>{t("roleProjectAdmin")}</SelectItem>
                <SelectItem value={ProjectMemberRole.DEVELOPER}>{t("roleDeveloper")}</SelectItem>
                <SelectItem value={ProjectMemberRole.GUEST}>{t("roleGuest")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            type="button"
            className="w-full md:w-auto md:justify-self-start"
            disabled={addDisabled}
            onClick={handleAdd}
          >
            <UserPlus />
            {busyId === "add" ? t("adding") : t("addMember")}
          </Button>
        </div>
      )}

      {members.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-12 py-10 text-center sm:px-5 sm:py-14">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <Users className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="divide-y overflow-hidden rounded-lg border sm:hidden">
            {members.map((member) => {
              const isOwner = member.userId === ownerUserId
              return (
                <article key={member.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.name || member.username || member.userId}
                    </p>
                    {member.name && member.username && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{member.username}</p>
                    )}
                    {identityMode === "MAPPED" && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {member.harborUsername
                          ? t("harborAccountMapped", { account: member.harborUsername })
                          : t("harborAccountMissing")}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-normal">
                        {roleLabel(member.role, t)}
                      </Badge>
                      {isOwner && <span className="text-xs text-muted-foreground">{t("owner")}</span>}
                    </div>
                  </div>
                  {removeMemberButton(member, isOwner)}
                </article>
              )
            })}
          </div>

          <div className="hidden overflow-hidden rounded-lg border sm:block">
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("user")}</TableHead>
                <TableHead>{t("role")}</TableHead>
                {isManager && <TableHead className="w-12"><span className="sr-only">{t("actions")}</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isOwner = member.userId === ownerUserId

                return (
                  <TableRow key={member.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {member.name || member.username || member.userId}
                        </span>
                        {member.name && member.username && (
                          <span className="text-xs text-muted-foreground">{member.username}</span>
                        )}
                        {identityMode === "MAPPED" && (
                          <span className="text-xs text-muted-foreground">
                            {member.harborUsername
                              ? t("harborAccountMapped", { account: member.harborUsername })
                              : t("harborAccountMissing")}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-normal">
                          {roleLabel(member.role, t)}
                        </Badge>
                        {isOwner && <span className="text-xs text-muted-foreground">{t("owner")}</span>}
                      </div>
                    </TableCell>
                    {isManager && (
                      <TableCell className="text-right">
                        {removeMemberButton(member, isOwner)}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
            </Table>
          </div>
        </>
      )}

      <section className="flex flex-col gap-3 pt-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <UsersRound className="size-4 text-muted-foreground" />
            {tg("title")}
          </h3>
          {/* Said out loud because it is the one place the Gateway's picture is knowingly
              incomplete: a group grant is real access that no member row here reflects. */}
          <p className="mt-1 text-sm text-muted-foreground">{tg("hint")}</p>
        </div>

        {isManager && (
          <div className="grid gap-3 md:grid-cols-[minmax(0,20rem)_10rem_auto] md:items-end">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="group-name">{tg("group")}</Label>
              <ProjectGroupPicker
                id="group-name"
                projectId={projectId}
                value={selectedGroup}
                onChange={setSelectedGroup}
                excludeNames={groups.map((group) => group.groupName)}
                disabled={busyId !== null}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="group-role">{t("role")}</Label>
              <Select
                value={selectedGroupRole}
                onValueChange={(value) => setSelectedGroupRole(value as ProjectMemberRole)}
              >
                <SelectTrigger id="group-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ProjectMemberRole.PROJECT_ADMIN}>{t("roleProjectAdmin")}</SelectItem>
                  <SelectItem value={ProjectMemberRole.DEVELOPER}>{t("roleDeveloper")}</SelectItem>
                  <SelectItem value={ProjectMemberRole.GUEST}>{t("roleGuest")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full md:w-auto md:justify-self-start"
              disabled={!selectedGroup || busyId !== null}
              onClick={handleAddGroup}
            >
              <UsersRound />
              {busyId === "add-group" ? tg("adding") : tg("addGroup")}
            </Button>
          </div>
        )}

        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tg("empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tg("group")}</TableHead>
                  <TableHead>{t("role")}</TableHead>
                  {isManager && (
                    <TableHead className="w-12">
                      <span className="sr-only">{t("actions")}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell className="font-medium">{group.groupName}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-normal">
                        {roleLabel(group.role, t)}
                      </Badge>
                    </TableCell>
                    {isManager && (
                      <TableCell className="text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={busyId !== null}
                              aria-label={tg("removeAria", { name: group.groupName })}
                            >
                              <Trash2 className="text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {tg("removeTitle", { name: group.groupName })}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {tg("removeDescription")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                disabled={busyId === `group:${group.groupName}`}
                                onClick={() => void handleRemoveGroup(group.groupName)}
                              >
                                {busyId === `group:${group.groupName}`
                                  ? tg("removing")
                                  : tg("removeSubmit")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}
