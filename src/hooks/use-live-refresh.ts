"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

/**
 * Keeping a page honest while something is still running.
 *
 * The Gateway has no scheduler and no websocket: a Job's outcome only reaches the UI because
 * somebody's browser asked. That makes the polling loop load-bearing rather than a nicety, and
 * it has to keep asking — the failure it replaced was a single `setTimeout` armed once when a
 * RUNNING row first appeared, which fired four seconds later, found the Job still running, and
 * never asked again. Every transfer that took longer than four seconds then sat on RUNNING
 * until the operator reloaded the page by hand.
 *
 * Two shapes, one loop:
 *
 * - `useLiveRefresh` re-reads the server component. Enough where the page derives its status
 *   from the live source on every render (mirrors ask their transport, the activity feed asks
 *   Kubernetes and Harbor).
 * - `useTransferSync` first POSTs to each request's sync endpoint, because a TransferTarget's
 *   status is *stored* and only that endpoint moves it off RUNNING. Refreshing without syncing
 *   would re-render the same stale row for ever.
 */

/** First interval, and the ceiling it decays to. */
const BASE_MS = 4_000
const MAX_MS = 30_000
const GROWTH = 1.5

/**
 * Chained timeouts rather than setInterval, and the delay grows towards MAX_MS.
 *
 * Chained, so a slow tick can never overlap the next one — each of these reaches Kubernetes or
 * a Harbor, and a stacked queue of them is how a page left open becomes a load generator.
 *
 * Growing, because "running" is not always temporary: a Job garbage-collected before anyone
 * looked leaves its target on RUNNING permanently (the activity feed calls this out as "not
 * reconciled"). A fixed 4s poll would then hammer the cluster for as long as the tab is open.
 * Decaying to 30s keeps the common case — a job that settles in seconds — as sharp as before,
 * and makes the pathological case cheap. The delay resets whenever `key` changes, so the next
 * thing to start running is picked up quickly again.
 */
function usePollingLoop(key: string, tick: () => Promise<void> | void) {
  const savedTick = React.useRef(tick)
  React.useEffect(() => {
    savedTick.current = tick
  })

  React.useEffect(() => {
    // An empty key means nothing is in flight — the loop simply does not exist.
    if (!key) return

    let cancelled = false
    let delay = BASE_MS
    let timer: ReturnType<typeof setTimeout>

    const run = async () => {
      await savedTick.current()
      if (cancelled) return
      delay = Math.min(delay * GROWTH, MAX_MS)
      timer = setTimeout(run, delay)
    }

    timer = setTimeout(run, delay)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key])
}

/**
 * Re-renders the server component while `key` is non-empty. Pass a key derived from whatever
 * is in flight — its identity is what re-arms the loop, so it must change when the set does
 * and stay stable while it does not.
 */
export function useLiveRefresh(key: string) {
  const router = useRouter()
  usePollingLoop(key, () => router.refresh())
}

/**
 * Settles running transfers, then re-renders. `requestIds` are the *requests* that still hold
 * a running target: the endpoint reconciles every destination of a request at once, so syncing
 * per target would be several calls doing the same work.
 */
export function useTransferSync(requestIds: string[]) {
  const router = useRouter()
  // Sorted and deduplicated so the key describes the *set*: two renders listing the same
  // requests in a different order must not count as a change and restart the backoff.
  const key = [...new Set(requestIds)].sort().join(",")

  usePollingLoop(
    key,
    React.useCallback(async () => {
      await Promise.all(
        key
          .split(",")
          .map((id) => fetch(`/api/transfers/${id}/sync`, { method: "POST" }).catch(() => {})),
      )
      router.refresh()
    }, [key, router]),
  )
}
