"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRight, Package, PackageOpen, Search } from "lucide-react"
import { useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"

export function RepoList({
  registryId,
  repos,
  fleetReturnTo,
}: {
  registryId: string
  repos: string[]
  fleetReturnTo: string
}) {
  const t = useTranslations("registries.repoList")
  const [query, setQuery] = React.useState("")
  const searchId = React.useId()

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = repos.filter((repo) => repo.toLowerCase().includes(normalizedQuery))
  const countLabel = normalizedQuery
    ? t("countFiltered", { filtered: filtered.length, total: repos.length })
    : t("count", { count: repos.length })

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <SearchInput
            id={searchId}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="max-w-sm"
          />
        <p aria-live="polite" className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {countLabel}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="animate-enter flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-4 py-16 text-center sm:py-20">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted">
            {repos.length === 0 ? (
              <PackageOpen className="size-5 text-muted-foreground" />
            ) : (
              <Search className="size-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {repos.length === 0 ? t("empty") : t("noResults", { query })}
            </p>
            <p className="text-sm text-muted-foreground">
              {repos.length === 0 ? t("emptyHint") : t("tryDifferent")}
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-md border" aria-label={t("listAria")}>
          {filtered.map((repo, i) => (
            <li key={repo}>
              <Link
                href={`/registries/${registryId}/${repo
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}?from=${encodeURIComponent(fleetReturnTo)}`}
                className="animate-enter group flex min-h-11 items-center justify-between gap-3 px-3 py-2.5 text-sm outline-none transition-colors duration-200 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                style={{ "--enter-delay": `${Math.min(i, 12) * 30}ms` } as React.CSSProperties}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <Package className="size-4 shrink-0 text-muted-foreground transition-colors duration-200 group-hover:text-foreground" />
                  <span className="truncate font-mono" title={repo}>
                    {repo}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
