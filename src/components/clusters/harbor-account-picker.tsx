"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// The account picker for a cluster that keeps its own user directory. Unlike UserPicker, the
// list comes from *Harbor* (/api/clusters/[id]/directory), not from the Gateway's own users:
// the whole point of a mapping is to name an account in a directory the Gateway does not
// hold. Free text is deliberately impossible here — a typed name is how an unrelated account
// with the same spelling ends up receiving somebody's access.

export interface HarborAccount {
  userId: number
  username: string
}

const SEARCH_DEBOUNCE_MS = 250

export function HarborAccountPicker({
  id,
  clusterId,
  value,
  onChange,
  disabled,
  className,
}: {
  id?: string
  clusterId: string
  /** Selected account name, or null. Controlled. */
  value: string | null
  onChange: (username: string | null) => void
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("harborAccountPicker")
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<HarborAccount[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return

    // Every keystroke supersedes the request in flight, so a slow Harbor can't overwrite
    // fresh results with stale ones.
    let active = true
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/clusters/${clusterId}/directory?q=${encodeURIComponent(query)}`
        )
        const body = await res.json().catch(() => null)
        if (!active) return
        if (!res.ok) {
          setResults([])
          setError(typeof body?.error === "string" ? body.error : t("searchFailed"))
          return
        }
        setResults(body.users ?? [])
        setTruncated(Boolean(body.truncated))
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
  }, [open, query, clusterId])

  function select(account: HarborAccount) {
    onChange(account.username)
    setOpen(false)
    setQuery("")
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (results.length === 0) return
      const delta = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((index) => (index + delta + results.length) % results.length)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const account = results[activeIndex]
      if (account) select(account)
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

          {!error && results.length === 0 && !loading && (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {query ? t("noMatch") : t("typeToSearch")}
            </p>
          )}

          {results.map((account, index) => (
            <button
              key={account.userId}
              type="button"
              role="option"
              aria-selected={account.username === value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(account)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                index === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              <Check
                className={cn(
                  "size-4 shrink-0",
                  account.username === value ? "opacity-100" : "opacity-0"
                )}
              />
              <span className="truncate">{account.username}</span>
            </button>
          ))}

          {truncated && <p className="px-2 py-2 text-xs text-muted-foreground">{t("moreMatch")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
