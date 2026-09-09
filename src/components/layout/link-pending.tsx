"use client"

import { useLinkStatus } from "next/link"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Must be rendered *inside* a `next/link`: reports that link's pending navigation. Kept
 * invisible for the first 150ms so instant (prefetched) navigations never flash a spinner.
 */
export function LinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <Loader2
      aria-hidden="true"
      className={cn("link-pending size-3.5 shrink-0 opacity-0", className)}
    />
  )
}
