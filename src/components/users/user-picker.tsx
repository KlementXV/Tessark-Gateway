"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface DirectoryUser {
  id: string
  username: string
  name: string | null
}

export function userLabel(user: DirectoryUser) {
  return user.name ? `${user.name} (${user.username})` : user.username
}

// The search runs against /api/users/directory rather than filtering a list held in the
// browser: with a directory-backed instance (LDAP) the account list is far too large to ship
// wholesale, so the server answers a query and caps what it returns.
const SEARCH_DEBOUNCE_MS = 250

export function UserPicker({
  id,
  value,
  onChange,
  excludeUserIds = [],
  placeholder,
  disabled,
  className,
}: {
  id?: string
  /** Selected user, or null. Controlled — the picker keeps only its own search state. */
  value: DirectoryUser | null
  onChange: (user: DirectoryUser | null) => void
  /** Users to hide from the results — existing members, the owner. */
  excludeUserIds?: string[]
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("userPicker")
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<DirectoryUser[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const excluded = React.useMemo(() => new Set(excludeUserIds), [excludeUserIds])

  React.useEffect(() => {
    if (!open) return

    // Every keystroke supersedes the request in flight, so a slow directory can't overwrite
    // fresh results with stale ones.
    let active = true
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/users/directory?q=${encodeURIComponent(query)}`)
        if (!res.ok) throw new Error("Directory unavailable")
        const body = (await res.json()) as { users: DirectoryUser[]; truncated: boolean }
        if (!active) return
        setResults(body.users)
        setTruncated(body.truncated)
        setActiveIndex(0)
      } catch {
        if (active) {
          setResults([])
          setError(t("searchFailed"))
        }
      } finally {
        if (active) setLoading(false)
      }
    }, query ? SEARCH_DEBOUNCE_MS : 0)

    return () => {
      active = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is stable for a given locale
  }, [open, query])

  const candidates = results.filter((user) => !excluded.has(user.id))

  function select(user: DirectoryUser) {
    onChange(user)
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
      const user = candidates[activeIndex]
      if (user) select(user)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          <span className="truncate">{value ? userLabel(value) : (placeholder ?? t("placeholder"))}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) p-0"
        // The search field owns the focus as soon as the list opens — the point of the picker
        // is that you type a name rather than scroll for it.
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

          {!error && candidates.length === 0 && !loading && (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {query ? t("noMatch") : t("noneAvailable")}
            </p>
          )}

          {candidates.map((user, index) => (
            <button
              key={user.id}
              type="button"
              role="option"
              aria-selected={user.id === value?.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(user)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                index === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              <Check
                className={cn("size-4 shrink-0", user.id === value?.id ? "opacity-100" : "opacity-0")}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{user.name || user.username}</span>
                {user.name && (
                  <span className="truncate text-xs text-muted-foreground">{user.username}</span>
                )}
              </span>
            </button>
          ))}

          {truncated && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("moreMatch")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
