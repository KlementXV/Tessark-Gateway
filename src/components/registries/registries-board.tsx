"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  IdCard,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerOff,
  Trash2,
  Unlink,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { ClusterFormDialog } from "@/components/clusters/cluster-form-dialog"
import { ClusterIdentitiesDialog } from "@/components/clusters/cluster-identities-dialog"
import { RegistryCard, type RegistryCardData } from "@/components/registries/registry-card"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { extractErrorMessage } from "@/lib/api-error"
import { isUsable } from "@/lib/registries/health"
import { minorSpread } from "@/lib/registries/harbor-capabilities"

export interface ClusterGroupView {
  id: string
  name: string
  description: string | null
  registryUrl: string | null
  replicationMode: string
  replicationCron: string | null
  identityMode: "GATEWAY" | "MAPPED"
  /** Members of this cluster's projects with no account mapped in its directory. */
  unmappedMembers: number
  projectCount: number
  members: RegistryCardData[]
}

type RegistryFilter = "all" | "healthy" | "attention" | "unassigned"

const MODE_KEYS: Record<string, "modeEvent" | "modeScheduled" | "modeNone"> = {
  event_based: "modeEvent",
  scheduled: "modeScheduled",
  none: "modeNone",
}

const FILTER_LABELS: Array<{
  value: RegistryFilter
  labelKey: "filterAll" | "filterHealthy" | "filterAttention" | "filterUnassigned"
}> = [
  { value: "all", labelKey: "filterAll" },
  { value: "healthy", labelKey: "filterHealthy" },
  { value: "attention", labelKey: "filterAttention" },
  { value: "unassigned", labelKey: "filterUnassigned" },
]

function matches(registry: RegistryCardData, query: string) {
  return (
    registry.name.toLowerCase().includes(query) ||
    registry.baseUrl.toLowerCase().includes(query) ||
    registry.description?.toLowerCase().includes(query)
  )
}

function matchesFilter(registry: RegistryCardData, filter: RegistryFilter) {
  if (filter === "healthy") return isUsable(registry.health)
  if (filter === "attention") {
    return !isUsable(registry.health) || Boolean(registry.pendingOperations)
  }
  return true
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">{children}</div>
}

// Registries remain grouped by cluster so placement and replication context is visible at
// a glance. Filters only affect the cards; cluster health counters always use full membership.
export function RegistriesBoard({
  groups,
  unassigned,
}: {
  groups: ClusterGroupView[]
  unassigned: RegistryCardData[]
}) {
  const t = useTranslations("registries.board")
  const tr = useTranslations("registries")
  const tc = useTranslations("common")
  const tIdentities = useTranslations("clusters.identities")
  const tCompat = useTranslations("harborCompatibility")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [query, setQuery] = React.useState(() => searchParams.get("q") ?? "")
  const [filter, setFilter] = React.useState<RegistryFilter>(() => {
    const candidate = searchParams.get("view")
    return FILTER_LABELS.some((option) => option.value === candidate)
      ? (candidate as RegistryFilter)
      : "all"
  })
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [addingTo, setAddingTo] = React.useState<ClusterGroupView | null>(null)
  // Projects the selected Harbor already holds, once the API has named them. Non-null means
  // the operator has been shown the consequence and the next click confirms it.
  const [pendingIncoming, setPendingIncoming] = React.useState<string[] | null>(null)
  const [registryId, setRegistryId] = React.useState("")

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search)
      if (query.trim()) params.set("q", query.trim())
      else params.delete("q")
      if (filter === "all") params.delete("view")
      else params.set("view", filter)
      const next = params.toString()
      window.history.replaceState(null, "", next ? `${pathname}?${next}` : pathname)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [filter, pathname, query])

  React.useEffect(() => {
    function restoreFromHistory() {
      const params = new URLSearchParams(window.location.search)
      const candidate = params.get("view")
      setQuery(params.get("q") ?? "")
      setFilter(
        FILTER_LABELS.some((option) => option.value === candidate)
          ? (candidate as RegistryFilter)
          : "all",
      )
    }
    window.addEventListener("popstate", restoreFromHistory)
    return () => window.removeEventListener("popstate", restoreFromHistory)
  }, [])

  const allRegistries = groups.flatMap((group) => group.members).concat(unassigned)
  const total = allRegistries.length
  const healthyCount = allRegistries.filter((registry) => isUsable(registry.health)).length
  const attentionCount = allRegistries.filter(
    (registry) => !isUsable(registry.health) || Boolean(registry.pendingOperations)
  ).length
  const normalizedQuery = query.trim().toLowerCase()
  const searching = normalizedQuery.length > 0

  const filterCounts: Record<RegistryFilter, number> = {
    all: total,
    healthy: healthyCount,
    attention: attentionCount,
    unassigned: unassigned.length,
  }

  const visibleGroups =
    filter === "unassigned"
      ? []
      : groups
          .map((group) => {
            const clusterMatches =
              !searching ||
              group.name.toLowerCase().includes(normalizedQuery) ||
              group.description?.toLowerCase().includes(normalizedQuery)
            const candidates = clusterMatches
              ? group.members
              : group.members.filter((registry) => matches(registry, normalizedQuery))
            return {
              group,
              clusterMatches,
              members: candidates.filter((registry) => matchesFilter(registry, filter)),
            }
          })
          .filter(({ clusterMatches, group, members }) => {
            if (filter === "all" && !searching) return true
            if (filter === "all" && clusterMatches && group.members.length === 0) return true
            return members.length > 0
          })

  const visibleUnassigned = unassigned.filter(
    (registry) =>
      (!searching || matches(registry, normalizedQuery)) && matchesFilter(registry, filter)
  )
  const visibleCount =
    visibleGroups.reduce((sum, entry) => sum + entry.members.length, 0) +
    visibleUnassigned.length
  const returnParams = new URLSearchParams()
  if (query.trim()) returnParams.set("q", query.trim())
  if (filter !== "all") returnParams.set("view", filter)
  const returnQuery = returnParams.toString()
  const returnTo = returnQuery ? `${pathname}?${returnQuery}` : pathname

  async function call(
    id: string,
    run: () => Promise<Response>,
    success: string,
    fallback: string
  ) {
    setBusyId(id)
    try {
      const res = await run()
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, fallback))
        return null
      }

      toast.success(success)
      router.refresh()
      return res
    } catch {
      toast.error(fallback)
      return null
    } finally {
      setBusyId(null)
    }
  }

  async function handleReconcile(cluster: ClusterGroupView) {
    setBusyId(cluster.id)
    try {
      const res = await fetch(`/api/clusters/${cluster.id}/reconcile`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("reconcileFailed")))
        return
      }

      const body = (await res.json()) as { replayed: number; remaining: number; unreachable: number }
      if (body.remaining === 0 && body.unreachable === 0) {
        toast.success(body.replayed > 0 ? t("replayed", { count: body.replayed }) : t("allInSync"))
      } else {
        toast.warning(
          t("replayedPartial", {
            replayed: body.replayed,
            remaining: body.remaining,
            unreachable: body.unreachable,
          })
        )
      }
      router.refresh()
    } catch {
      toast.error(t("reconcileFailed"))
    } finally {
      setBusyId(null)
    }
  }

  // Two-step on purpose. Joining a cluster arms a replication mesh that pushes everything the
  // candidate holds to every peer, so a Harbor that is not empty gets its projects listed back
  // and the join is re-sent only once someone has read them. A name collision is refused
  // outright and never reaches this confirmation — no answer to it is safe.
  async function handleAddMember(acceptExisting = false) {
    if (!addingTo || !registryId) return
    setBusyId(addingTo.id)
    try {
      const res = await fetch(`/api/clusters/${addingTo.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryId, acceptExisting }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; incoming?: string[] }
          | null
        if (body?.incoming?.length) {
          setPendingIncoming(body.incoming)
          return
        }
        toast.error(extractErrorMessage(body, t("memberAddFailed")))
        return
      }

      toast.success(t("memberAdded"))
      router.refresh()
      setAddingTo(null)
      setRegistryId("")
      setPendingIncoming(null)
    } catch {
      toast.error(t("memberAddFailed"))
    } finally {
      setBusyId(null)
    }
  }

  function resetView() {
    setQuery("")
    setFilter("all")
  }

  if (total === 0 && groups.length === 0) {
    return (
      <div className="px-4 lg:px-6">
        <div className="animate-enter flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-5 py-16 text-center sm:py-20">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <ServerOff className="size-5 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        <div className="flex flex-col gap-3 border-y py-3 @3xl/main:flex-row @3xl/main:items-center">
          <SearchInput
            id="registry-search"
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="@3xl/main:max-w-xs"
          />

          <div className="scrollbar-none -mx-1 flex max-w-full overflow-x-auto px-1 py-0.5 @3xl/main:mx-0 @3xl/main:flex-1">
            <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/70 p-1" role="group" aria-label={t("filterAria")}>
              {FILTER_LABELS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={filter === option.value ? "outline" : "ghost"}
                  size="sm"
                  className="h-7 shrink-0 px-2 shadow-none"
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                >
                  {t(option.labelKey)}
                  <span className="text-xs tabular-nums opacity-60">
                    {filterCounts[option.value]}
                  </span>
                </Button>
              ))}
            </div>
          </div>

          <p className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {tr("count", { count: visibleCount })}
          </p>
        </div>

        {visibleCount === 0 && visibleGroups.length === 0 ? (
          <div className="animate-enter flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-5 py-16 text-center sm:py-20">
            <div className="flex size-11 items-center justify-center rounded-md bg-muted">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">
                {searching
                  ? t("noResults", { query: query.trim() })
                  : filter === "healthy"
                    ? t("noHealthy")
                    : filter === "attention"
                      ? t("noAttention")
                      : t("noUnassigned")}
              </p>
              <p className="text-sm text-muted-foreground">{t("adjust")}</p>
            </div>
            <Button variant="outline" size="sm" onClick={resetView}>
              <X />
              {t("clearFilters")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {visibleGroups.map(({ group: cluster, members }, index) => {
              const queued = cluster.members.reduce(
                (sum, member) => sum + (member.pendingOperations ?? 0),
                0
              )
              const unavailable = cluster.members.filter(
                (member) => !isUsable(member.health)
              ).length
              // The live reading when there is one, the last observed otherwise: a member that is
              // momentarily down still ran a known version a moment ago, and dropping it from the
              // comparison would make a mixed cluster look uniform.
              const spread = minorSpread(
                cluster.members.map((member) => member.health.version ?? member.harborVersion)
              )

              return (
                <section
                  key={cluster.id}
                  className="animate-enter flex flex-col gap-3 border-t pt-5 first:border-t-0 first:pt-0"
                  style={{ "--enter-delay": `${Math.min(index, 8) * 40}ms` } as React.CSSProperties}
                >
                  <header className="flex flex-col gap-3 @xl/main:flex-row @xl/main:items-start @xl/main:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                        <Network className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* The cluster's own page, where its mesh, its directory and its
                              members are shown at full size. The list stays the place where
                              membership is *edited*, so both are one click apart. */}
                          <h2 className="min-w-0 truncate text-base font-semibold">
                            <Link
                              href={`/registries/clusters/${cluster.id}`}
                              className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            >
                              {cluster.name}
                            </Link>
                          </h2>
                          {unavailable > 0 && (
                            <Badge variant="destructive">{t("unavailableBadge", { count: unavailable })}</Badge>
                          )}
                          {queued > 0 && (
                            <Badge className="bg-warning/15 text-warning">{t("queuedBadge", { count: queued })}</Badge>
                          )}
                          {spread.minors.length > 1 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge className="bg-warning/15 text-warning">
                                  {spread.minors.join(" · ")}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                {tCompat("fleetDivergence", {
                                  count: spread.minors.length,
                                  minors: spread.minors.join(", "),
                                })}
                                {spread.unknown > 0 && ` — ${tCompat("fleetUnknown", { count: spread.unknown })}`}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        {cluster.description && (
                          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
                            {cluster.description}
                          </p>
                        )}
                        {cluster.registryUrl && (
                          <p
                            className="mt-1 truncate font-mono text-xs text-muted-foreground"
                            title={t("publishedAddress", { cluster: cluster.name })}
                          >
                            {cluster.registryUrl}
                          </p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span>{tr("count", { count: cluster.members.length })}</span>
                          <span className="size-0.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                          <span>{tr("projectsCount", { count: cluster.projectCount })}</span>
                          <span className="size-0.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                          <span>{MODE_KEYS[cluster.replicationMode] ? t(MODE_KEYS[cluster.replicationMode]) : cluster.replicationMode}</span>
                          {cluster.replicationCron && (
                            <code className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                              {cluster.replicationCron}
                            </code>
                          )}
                          {cluster.unmappedMembers > 0 && (
                            <>
                              <span
                                className="size-0.5 rounded-full bg-muted-foreground/50"
                                aria-hidden="true"
                              />
                              <span className="text-warning">
                                {tIdentities("unmapped", { count: cluster.unmappedMembers })}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 self-end @xl/main:self-auto">
                      {unassigned.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === cluster.id}
                          onClick={() => setAddingTo(cluster)}
                        >
                          <Plus />
                          {t("addRegistry")}
                        </Button>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={busyId === cluster.id || cluster.members.length === 0}
                            onClick={() => handleReconcile(cluster)}
                            aria-label={t("reconcileAria", { cluster: cluster.name })}
                          >
                            <RefreshCw className={busyId === cluster.id ? "animate-spin" : undefined} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t("reconcileCluster")}</TooltipContent>
                      </Tooltip>
                      {cluster.identityMode === "MAPPED" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <ClusterIdentitiesDialog
                                clusterId={cluster.id}
                                clusterName={cluster.name}
                                trigger={
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={tIdentities("manageAria", { cluster: cluster.name })}
                                  >
                                    <IdCard />
                                  </Button>
                                }
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent sideOffset={6}>{tIdentities("manage")}</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">
                            <ClusterFormDialog
                              cluster={{
                                id: cluster.id,
                                name: cluster.name,
                                description: cluster.description ?? "",
                                registryUrl: cluster.registryUrl ?? "",
                                replicationMode: cluster.replicationMode as
                                  | "event_based"
                                  | "scheduled"
                                  | "none",
                                replicationCron: cluster.replicationCron ?? "0 0 * * * *",
                                identityMode: cluster.identityMode,
                              }}
                              trigger={
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={t("editAria", { cluster: cluster.name })}
                                >
                                  <Pencil />
                                </Button>
                              }
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t("editCluster")}</TooltipContent>
                      </Tooltip>
                      <AlertDialog>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <AlertDialogTrigger asChild>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="text-muted-foreground hover:text-destructive"
                                  disabled={busyId === cluster.id}
                                  aria-label={t("deleteAria", { cluster: cluster.name })}
                                >
                                  <Trash2 />
                                </Button>
                              </AlertDialogTrigger>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent sideOffset={6}>{t("deleteCluster")}</TooltipContent>
                        </Tooltip>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("deleteTitle", { cluster: cluster.name })}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {cluster.projectCount > 0
                                ? t("deleteBlocked", { count: cluster.projectCount })
                                : t("deleteDescription")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              disabled={cluster.projectCount > 0}
                              onClick={() =>
                                call(
                                  cluster.id,
                                  () => fetch(`/api/clusters/${cluster.id}`, { method: "DELETE" }),
                                  t("clusterDeleted"),
                                  t("clusterDeleteFailed")
                                )
                              }
                            >
                              {t("deleteCluster")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </header>

                  {members.length === 0 ? (
                    <div className="rounded-lg border border-dashed bg-muted/15 px-4 py-6 text-center">
                      <p className="text-sm font-medium">{t("emptyClusterTitle")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t("emptyClusterHint")}</p>
                    </div>
                  ) : (
                    <CardGrid>
                      {members.map((member) => (
                        <RegistryCard
                          key={member.id}
                          registry={member}
                          returnTo={returnTo}
                          action={
                            <AlertDialog>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <AlertDialogTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="text-muted-foreground hover:text-destructive"
                                        aria-label={t("removeMemberAria", { registry: member.name, cluster: cluster.name })}
                                        disabled={busyId === cluster.id}
                                      >
                                        <Unlink />
                                      </Button>
                                    </AlertDialogTrigger>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent sideOffset={6}>{t("removeFromCluster")}</TooltipContent>
                              </Tooltip>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {t("removeMemberTitle", { registry: member.name, cluster: cluster.name })}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>{t("removeMemberDescription")}</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                                  <AlertDialogAction
                                    variant="destructive"
                                    onClick={() =>
                                      call(
                                        cluster.id,
                                        () =>
                                          fetch(
                                            `/api/clusters/${cluster.id}/members?registryId=${member.id}`,
                                            { method: "DELETE" }
                                          ),
                                        t("memberRemoved"),
                                        t("memberRemoveFailed")
                                      )
                                    }
                                  >
                                    {t("removeRegistry")}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          }
                        />
                      ))}
                    </CardGrid>
                  )}
                </section>
              )
            })}

            {visibleUnassigned.length > 0 && (
              <section className="animate-enter flex flex-col gap-3 border-t pt-5">
                <header className="flex min-w-0 items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                    <ServerOff className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{t("unassigned")}</h2>
                      <Badge variant="secondary">{tr("count", { count: visibleUnassigned.length })}</Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{t("unassignedHint")}</p>
                  </div>
                </header>
                <CardGrid>
                  {visibleUnassigned.map((registry) => (
                    <RegistryCard key={registry.id} registry={registry} returnTo={returnTo} />
                  ))}
                </CardGrid>
              </section>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(addingTo)}
        onOpenChange={(open) => {
          if (open) return
          setAddingTo(null)
          setPendingIncoming(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("addToTitle", { cluster: addingTo?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("addToDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="cluster-registry">{t("registry")}</Label>
            <Select
              value={registryId}
              onValueChange={(value) => {
                setRegistryId(value)
                // The list belonged to the previous candidate; keeping it would let a confirmed
                // click carry acceptExisting over to a Harbor nobody inspected.
                setPendingIncoming(null)
              }}
            >
              <SelectTrigger id="cluster-registry">
                <SelectValue placeholder={t("selectRegistry")} />
              </SelectTrigger>
              <SelectContent>
                {/* A delivery registry is unassigned by definition — the Gateway only pushes
                    images to it — so it is never a candidate for cluster membership. */}
                {unassigned
                  .filter((registry) => registry.role !== "DELIVERY")
                  .map((registry) => (
                    <SelectItem key={registry.id} value={registry.id}>
                      {registry.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {pendingIncoming && (
            <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
              <p className="text-xs font-medium text-warning">{t("joinExistingTitle")}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("joinExistingBody", { names: pendingIncoming.join(", ") })}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={!registryId || busyId === addingTo?.id}
              onClick={() => handleAddMember(pendingIncoming !== null)}
            >
              {busyId === addingTo?.id && <RefreshCw className="animate-spin" />}
              {busyId === addingTo?.id
                ? t("adding")
                : pendingIncoming
                  ? t("joinExistingConfirm")
                  : t("addRegistry")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
