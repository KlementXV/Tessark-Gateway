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
//
// Two sources can answer and they are not worth the same, so the list says which one did: the
// LDAP directory itself (people who never signed in to Harbor included, exact identifier only)
// or just the accounts Harbor already holds. See src/lib/clusters/directory.ts.

export interface HarborAccount {
  /** Null for a directory account this Harbor has not created yet. */
  userId: number | null
  username: string
  realname?: string | null
  source?: "directory" | "harbor"
  knownToHarbor?: boolean
}

interface SearchState {
  source: "directory" | "harbor" | null
  reason: string | null
  provisioning: string | null
  directoryError: string | null
}

const NO_STATE: SearchState = { source: null, reason: null, provisioning: null, directoryError: null }

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
  const [state, setState] = React.useState<SearchState>(NO_STATE)
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
          setState(NO_STATE)
          setError(typeof body?.error === "string" ? body.error : t("searchFailed"))
          return
        }
        setResults(body.users ?? [])
        setTruncated(Boolean(body.truncated))
        setState({
          source: body.source ?? null,
          reason: body.capability?.reason ?? null,
          provisioning: body.capability?.provisioning ?? null,
          directoryError: typeof body.directoryError === "string" ? body.directoryError : null,
        })
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

  // Which source answered, said in words: an empty list from Harbor's own table and an empty
  // list from the directory mean very different things.
  const sourceNote = state.directoryError
    ? t("directoryFailed", { error: state.directoryError })
    : state.source === "directory"
      ? t("sourceDirectory")
      : state.source === "harbor"
        ? state.reason === "configuration-unreadable"
          ? t("sourceUnreadable")
          : t("sourceHarbor")
        : null

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
              key={account.username}
              type="button"
              role="option"
              aria-selected={account.username === value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(account)}
              className={cn(
                "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                index === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              <Check
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  account.username === value ? "opacity-100" : "opacity-0"
                )}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  {account.username}
                  {account.realname && (
                    <span className="text-muted-foreground"> · {account.realname}</span>
                  )}
                </span>
                {account.knownToHarbor === false && (
                  <span
                    className={cn(
                      "text-xs",
                      state.provisioning === "first-sign-in" ? "text-warning" : "text-muted-foreground"
                    )}
                  >
                    {state.provisioning === "first-sign-in" ? t("firstSignInRequired") : t("notInHarborYet")}
                  </span>
                )}
              </span>
            </button>
          ))}

          {truncated && <p className="px-2 py-2 text-xs text-muted-foreground">{t("moreMatch")}</p>}
        </div>

        {sourceNote && (
          <p
            className={cn(
              "border-t px-3 py-2 text-xs",
              state.directoryError ? "text-warning" : "text-muted-foreground"
            )}
          >
            {sourceNote}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
