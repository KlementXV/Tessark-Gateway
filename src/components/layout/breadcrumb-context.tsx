"use client"

import * as React from "react"

export type Crumb = { label: string; href?: string }

type BreadcrumbState = {
  crumbs: Crumb[] | null
  setCrumbs: (crumbs: Crumb[] | null) => void
}

const BreadcrumbContext = React.createContext<BreadcrumbState | null>(null)

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [crumbs, setCrumbs] = React.useState<Crumb[] | null>(null)
  const value = React.useMemo(() => ({ crumbs, setCrumbs }), [crumbs])
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>
}

export function useBreadcrumbOverride() {
  return React.useContext(BreadcrumbContext)?.crumbs ?? null
}

/**
 * Lets a page name itself in the header. The header derives generic crumbs from the URL
 * ("Projects › Project details"); an entity page renders this to replace the tail with the
 * real name ("Projects › payments-api") once its data is loaded. Clears on unmount so the
 * next page falls back to the URL-derived crumbs until it sets its own.
 */
export function PageBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  const ctx = React.useContext(BreadcrumbContext)
  const setCrumbs = ctx?.setCrumbs
  const key = JSON.stringify(crumbs)

  React.useLayoutEffect(() => {
    if (!setCrumbs) return
    setCrumbs(JSON.parse(key) as Crumb[])
    return () => setCrumbs(null)
  }, [key, setCrumbs])

  return null
}
