"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { Boxes, CheckCircle2, ChevronRight, Clock3, Globe2, LockKeyhole, Search, TriangleAlert, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface ProjectListItem {
  id: string
  name: string
  description: string | null
  status: "PENDING" | "ACTIVE" | "REJECTED"
  isPublic: boolean
  ownerUserId: string | null
  cluster: { name: string; _count: { registries: number } }
  placements: { status: "PENDING" | "ACTIVE" | "FAILED" }[]
}

type ProjectFilter = "all" | "public" | "private" | "attention"
type ProjectSort = "name" | "cluster" | "attention"

const FILTERS: Array<{ value: ProjectFilter; labelKey: "filterAll" | "filterPublic" | "filterPrivate" | "filterAttention" }> = [
  { value: "all", labelKey: "filterAll" },
  { value: "public", labelKey: "filterPublic" },
  { value: "private", labelKey: "filterPrivate" },
  { value: "attention", labelKey: "filterAttention" },
]

const SORTS: Array<{ value: ProjectSort; labelKey: "sortName" | "sortCluster" | "sortAttention" }> = [
  { value: "name", labelKey: "sortName" },
  { value: "cluster", labelKey: "sortCluster" },
  { value: "attention", labelKey: "sortAttention" },
]

function needsAttention(project: ProjectListItem) {
  const synced = project.placements.filter((placement) => placement.status === "ACTIVE").length
  return project.status !== "ACTIVE" || synced < project.cluster._count.registries
}

function matchesFilter(project: ProjectListItem, filter: ProjectFilter) {
  if (filter === "public") return project.isPublic
  if (filter === "private") return !project.isPublic
  if (filter === "attention") return needsAttention(project)
  return true
}

export function ProjectsList({ projects }: { projects: ProjectListItem[] }) {
  const t = useTranslations("projects.list")
  const tp = useTranslations("projects")
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [query, setQuery] = React.useState(() => searchParams.get("q") ?? "")
  const [filter, setFilter] = React.useState<ProjectFilter>(() => {
    const candidate = searchParams.get("view")
    return FILTERS.some((option) => option.value === candidate)
      ? (candidate as ProjectFilter)
      : "all"
  })
  const [sort, setSort] = React.useState<ProjectSort>(() => {
    const candidate = searchParams.get("sort")
    return SORTS.some((option) => option.value === candidate) ? (candidate as ProjectSort) : "name"
  })

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search)
      if (query.trim()) params.set("q", query.trim())
      else params.delete("q")
      if (filter === "all") params.delete("view")
      else params.set("view", filter)
      if (sort === "name") params.delete("sort")
      else params.set("sort", sort)
      const next = params.toString()
      window.history.replaceState(null, "", next ? `${pathname}?${next}` : pathname)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [filter, pathname, query, sort])

  React.useEffect(() => {
    function restoreFromHistory() {
      const params = new URLSearchParams(window.location.search)
      const candidate = params.get("view")
      const sortCandidate = params.get("sort")
      setQuery(params.get("q") ?? "")
      setFilter(
        FILTERS.some((option) => option.value === candidate)
          ? (candidate as ProjectFilter)
          : "all",
      )
      setSort(
        SORTS.some((option) => option.value === sortCandidate)
          ? (sortCandidate as ProjectSort)
          : "name",
      )
    }
    window.addEventListener("popstate", restoreFromHistory)
    return () => window.removeEventListener("popstate", restoreFromHistory)
  }, [])
  const normalizedQuery = query.trim().toLowerCase()
  const searching = normalizedQuery.length > 0

  const counts: Record<ProjectFilter, number> = {
    all: projects.length,
    public: projects.filter((project) => project.isPublic).length,
    private: projects.filter((project) => !project.isPublic).length,
    attention: projects.filter(needsAttention).length,
  }

  const visibleProjects = projects
    .filter((project) => {
      const matchesQuery =
        !searching ||
        project.name.toLowerCase().includes(normalizedQuery) ||
        project.cluster.name.toLowerCase().includes(normalizedQuery) ||
        project.description?.toLowerCase().includes(normalizedQuery)
      return matchesQuery && matchesFilter(project, filter)
    })
    .sort((a, b) => {
      if (sort === "cluster") {
        return a.cluster.name.localeCompare(b.cluster.name) || a.name.localeCompare(b.name)
      }
      if (sort === "attention") {
        return Number(needsAttention(b)) - Number(needsAttention(a)) || a.name.localeCompare(b.name)
      }
      return a.name.localeCompare(b.name)
    })

  const returnParams = new URLSearchParams()
  if (query.trim()) returnParams.set("q", query.trim())
  if (filter !== "all") returnParams.set("view", filter)
  if (sort !== "name") returnParams.set("sort", sort)
  const returnQuery = returnParams.toString()
  const returnTo = returnQuery ? `${pathname}?${returnQuery}` : pathname

  function resetView() {
    setQuery("")
    setFilter("all")
    setSort("name")
  }

  if (projects.length === 0) {
    return (
      <div className="px-4 lg:px-6">
        <div className="animate-enter flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-5 py-16 text-center sm:py-20">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <Boxes className="size-5 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 px-4 lg:px-6">
      <div className="flex flex-col gap-3 rounded-xl border bg-muted/25 p-3 @5xl/main:flex-row @5xl/main:items-center">
        <SearchInput
            id="project-search"
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="@5xl/main:max-w-xs"
          />

        <div className="scrollbar-none -mx-1 flex max-w-full overflow-x-auto px-1 py-0.5 @5xl/main:mx-0 @5xl/main:flex-1">
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/70 p-1"
            role="group"
            aria-label={t("filterAria")}
          >
            {FILTERS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={filter === option.value ? "outline" : "ghost"}
                size="sm"
                className="h-9 shrink-0 px-2.5 shadow-none"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {t(option.labelKey)}
                <span className="text-xs tabular-nums opacity-60">{counts[option.value]}</span>
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 @5xl/main:justify-end">
          <Label htmlFor="project-sort" className="sr-only">
            {t("sortAria")}
          </Label>
          <Select value={sort} onValueChange={(value) => setSort(value as ProjectSort)}>
            <SelectTrigger id="project-sort" className="w-40">
              <SelectValue>{t(SORTS.find((option) => option.value === sort)!.labelKey)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <p className="text-xs tabular-nums text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
          {t("resultsCount", { count: visibleProjects.length, total: projects.length })}
        </p>
        {(searching || filter !== "all" || sort !== "name") && (
          <Button type="button" variant="ghost" size="sm" onClick={resetView}>
            <X />
            {t("clearFilters")}
          </Button>
        )}
      </div>

      {visibleProjects.length === 0 ? (
        <div className="animate-enter flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-5 py-16 text-center sm:py-20">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            {filter === "attention" && !searching ? (
              <TriangleAlert className="size-5 text-muted-foreground" />
            ) : (
              <Search className="size-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {searching
                ? t("noResults", { query: query.trim() })
                : filter === "attention"
                  ? t("allInSync")
                  : t("noFilterProjects", { filter })}
            </p>
            <p className="text-sm text-muted-foreground">{t("adjust")}</p>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_minmax(0,0.55fr)_7rem_10rem_1rem] items-center gap-4 border-b bg-muted/40 px-5 py-3 text-xs font-medium text-muted-foreground @3xl/main:grid">
            <span>{t("columnProject")}</span>
            <span>{t("columnCluster")}</span>
            <span>{t("columnVisibility")}</span>
            <span>{t("columnStatus")}</span>
            <span />
          </div>
          <ul className="divide-y">
            {visibleProjects.map((project, index) => {
              const targetCount = project.cluster._count.registries
              const syncedCount = project.placements.filter(
                (placement) => placement.status === "ACTIVE"
              ).length
              const outOfSync = needsAttention(project)
              const StatusIcon = project.status === "PENDING" ? Clock3 : outOfSync ? TriangleAlert : CheckCircle2
              const statusLabel = project.status === "PENDING"
                ? tp("statusPending")
                : project.status === "REJECTED"
                  ? tp("statusRejected")
                  : tp("harborsRatio", { synced: syncedCount, total: targetCount })
              const statusClass = project.status === "REJECTED" ? "text-destructive" : outOfSync ? "text-warning" : "text-success"

              return (
                <li
                  key={project.id}
                  className="animate-enter"
                  style={{ "--enter-delay": `${Math.min(index, 12) * 30}ms` } as React.CSSProperties}
                >
                  <Link
                    href={`/projects/${project.id}?from=${encodeURIComponent(returnTo)}`}
                    className="group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @3xl/main:grid-cols-[minmax(0,1fr)_minmax(0,0.55fr)_7rem_10rem_1rem] @3xl/main:px-5"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/70">
                        <Boxes className="size-5 text-muted-foreground" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 py-0.5">
                        <span className="block truncate text-sm font-medium">{project.name}</span>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 @3xl/main:hidden">
                          <span className="max-w-full truncate text-xs text-muted-foreground">
                            {project.cluster.name}
                          </span>
                          {project.isPublic ? (
                            <Badge variant="outline" className="h-5 gap-1 rounded-md px-1.5 font-normal">
                              <Globe2 className="size-3" />
                              {tp("public")}
                            </Badge>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <LockKeyhole className="size-3" />
                              {tp("private")}
                            </span>
                          )}
                          <span className={cn("inline-flex items-center gap-1 text-xs", statusClass)}>
                            <StatusIcon className="size-3" aria-hidden="true" />
                            {statusLabel}
                          </span>
                        </div>
                        {project.description && (
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground sm:truncate">
                            {project.description}
                          </p>
                        )}
                      </div>
                    </div>

                    <span className="hidden min-w-0 truncate text-sm text-muted-foreground @3xl/main:block" title={project.cluster.name}>
                      <span className="sr-only">{t("columnCluster")}: </span>
                      {project.cluster.name}
                    </span>
                    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground @3xl/main:inline-flex">
                      {project.isPublic ? <Globe2 className="size-3.5" aria-hidden="true" /> : <LockKeyhole className="size-3.5" aria-hidden="true" />}
                      {project.isPublic ? tp("public") : tp("private")}
                    </span>
                    <span className={cn("hidden items-center gap-1.5 text-xs @3xl/main:inline-flex", statusClass)}>
                      <StatusIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      {statusLabel}
                    </span>

                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
