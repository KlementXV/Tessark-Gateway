"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Tabs } from "@/components/ui/tabs"

export function UrlTabs({
  param,
  values,
  fallback,
  ...props
}: Omit<React.ComponentProps<typeof Tabs>, "value" | "defaultValue" | "onValueChange"> & {
  param: string
  values: readonly string[]
  fallback: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const raw = searchParams.get(param)
  const value = raw && values.includes(raw) ? raw : fallback

  function change(nextValue: string) {
    const next = new URLSearchParams(searchParams.toString())
    if (nextValue === fallback) next.delete(param)
    else next.set(param, nextValue)
    const query = next.toString()
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return <Tabs value={value} onValueChange={change} {...props} />
}
