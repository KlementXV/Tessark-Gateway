"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// The directory groups the project's cluster knows, fetched once when the list opens and
// filtered in the browser afterwards: Harbor returns the whole set (there are rarely more than
// a handful), unlike its user directory, which has to be searched server-side.

export interface DirectoryGroup {
  id: number
  name: string
  type: number
}

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
    } catch {
      setGroups([])
      setError(t("searchFailed"))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  const excluded = React.useMemo(
    () => new Set(excludeNames.map((name) => name.toLowerCase())),
    [excludeNames]
  )
  const candidates = (groups ?? []).filter(
    (group) =>
      !excluded.has(group.name.toLowerCase()) &&
      group.name.toLowerCase().includes(query.trim().toLowerCase())
  )

  function select(group: DirectoryGroup) {
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
              key={group.id}
              type="button"
              role="option"
              aria-selected={group.name === value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(group)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                index === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              <Check
                className={cn("size-4 shrink-0", group.name === value ? "opacity-100" : "opacity-0")}
              />
              <span className="truncate">{group.name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
