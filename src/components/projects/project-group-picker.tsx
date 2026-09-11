"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// The directory groups the project's cluster knows. The groups Harbor has registered are
// fetched once when the list opens and filtered in the browser afterwards (there are rarely more
// than a handful). When that Harbor has an LDAP directory configured, what is typed is also
// looked up there by exact name, so a group Harbor has never seen can be picked — its DN comes
// from the directory, never from this form.

export interface DirectoryGroup {
  /** Null for a directory group Harbor has not registered yet. */
  id: number | null
  name: string
  type: number | null
  dn?: string | null
  source?: "directory" | "harbor"
  /** False when this Harbor cannot take a directory group it has not registered. */
  grantable?: boolean
}

interface Listing {
  source: "directory" | "harbor" | null
  directoryError: string | null
}

const SEARCH_DEBOUNCE_MS = 300

export function ProjectGroupPicker({
  id,
  projectId,
  value,
  onChange,
  excludeNames = [],
  disabled,
  className,
}: {
  id?: string
  projectId: string
  value: string | null
  onChange: (groupName: string | null) => void
  /** Groups already granted on this project. */
  excludeNames?: string[]
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("projects.groups")
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [groups, setGroups] = React.useState<DirectoryGroup[] | null>(null)
  const [directoryHits, setDirectoryHits] = React.useState<DirectoryGroup[]>([])
  const [listing, setListing] = React.useState<Listing>({ source: null, directoryError: null })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/groups/search`)
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setGroups([])
        setError(typeof body?.error === "string" ? body.error : t("searchFailed"))
        return
      }
      setGroups(body.groups ?? [])
      setListing({ source: body.source ?? null, directoryError: body.directoryError ?? null })
    } catch {
      setGroups([])
      setError(t("searchFailed"))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  // The directory is only asked once something is typed, and only when this cluster has one:
  // its lookup is by exact name, so there is nothing to ask it about an empty field.
  const directoryQuery = open && listing.source === "directory" ? query.trim() : ""
  React.useEffect(() => {
    const q = directoryQuery
    if (!q) return
    let active = true
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/groups/search?q=${encodeURIComponent(q)}`)
        const body = await res.json().catch(() => null)
        if (!active || !res.ok) return
        setDirectoryHits(
          ((body.groups ?? []) as DirectoryGroup[]).filter((group) => group.source === "directory")
        )
        setListing((current) => ({ ...current, directoryError: body.directoryError ?? null }))
      } catch {
        if (active) setDirectoryHits([])
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [directoryQuery, projectId])

  const excluded = React.useMemo(
    () => new Set(excludeNames.map((name) => name.toLowerCase())),
    [excludeNames]
  )
  const registered = (groups ?? []).filter(
    (group) =>
      !excluded.has(group.name.toLowerCase()) &&
      group.name.toLowerCase().includes(query.trim().toLowerCase())
  )
  const registeredNames = new Set(registered.map((group) => group.name.toLowerCase()))
  // Hits from an earlier query are kept in state but only shown while a directory query is live.
  const candidates = [
    ...(directoryQuery ? directoryHits : []).filter(
      (group) => !excluded.has(group.name.toLowerCase()) && !registeredNames.has(group.name.toLowerCase())
    ),
    ...registered,
  ]

  function select(group: DirectoryGroup) {
    if (group.grantable === false) return
    onChange(group.name)
    setOpen(false)
    setQuery("")
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (candidates.length === 0) return
      const delta = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((index) => (index + delta + candidates.length) % candidates.length)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const group = candidates[activeIndex]
      if (group) select(group)
    }
  }

  const sourceNote = listing.directoryError
    ? t("directoryFailed", { error: listing.directoryError })
    : listing.source === "directory"
      ? t("sourceDirectory")
      : listing.source === "harbor"
        ? t("sourceHarbor")
        : null

  return (
    <Popover
      open={open}
      // Fetched on open rather than from an effect: the list is a snapshot of a remote state,
      // and opening the picker is the event that asks for a fresh one.
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
            className
          )}
        >
          <span className="truncate">{value ?? t("placeholder")}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="relative border-b">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAria")}
            className="border-0 pl-9 shadow-none focus-visible:ring-0"
          />
          {loading && (
            <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        <div className="max-h-64 overflow-y-auto p-1" role="listbox">
          {error && <p className="px-2 py-3 text-sm text-destructive">{error}</p>}

          {!error && !loading && candidates.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {query ? t("noMatch") : t("noneAvailable")}
            </p>
          )}

          {candidates.map((group, index) => (
            <button
              key={`${group.source ?? "harbor"}:${group.name}`}
              type="button"
              role="option"
              aria-selected={group.name === value}
              aria-disabled={group.grantable === false}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(group)}
              className={cn(
                "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                index === activeIndex && "bg-accent text-accent-foreground",
                group.grantable === false && "cursor-not-allowed opacity-60"
              )}
            >
              <Check
                className={cn("mt-0.5 size-4 shrink-0", group.name === value ? "opacity-100" : "opacity-0")}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{group.name}</span>
                {group.source === "directory" && (
                  <span className="text-xs text-muted-foreground">
                    {group.grantable === false ? t("groupNotGrantable") : t("fromDirectory")}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {sourceNote && (
          <p
            className={cn(
              "border-t px-3 py-2 text-xs",
              listing.directoryError ? "text-warning" : "text-muted-foreground"
            )}
          >
            {sourceNote}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
