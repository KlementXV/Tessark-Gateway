import { prisma } from "@/lib/prisma"
import type { RegistryHealth } from "./health"

/**
 * The last Harbor version seen on a registry, cached on its row.
 *
 * Why a cache at all: the fleet view shows one line per registry, and asking every Harbor for
 * `/systeminfo` on each render costs one round trip per member — a page that a slow peer can hold
 * hostage. Why it is *only* a cache: a version decides what the Gateway is allowed to send, and a
 * value read minutes ago can be wrong right after an upgrade. So every operation that depends on
 * the version reads it live; this column exists to *display* a fleet, and to say how old the
 * reading is (plan D3).
 *
 * Two rules give it its integrity:
 *
 *  - only a **successful** observation is written. A Harbor that went unreachable keeps its last
 *    known version and its original timestamp, shown as stale — replacing it with null would
 *    erase what we knew, and refreshing the date would claim a reading that never happened;
 *  - an observation is written only if the row still points at **the URL that was probed**. The
 *    check route accepts an id together with an edited baseUrl, so a probe in flight can belong
 *    to a target the row no longer has.
 */

/** Beyond this, the UI presents the reading as aged rather than current. */
export const HARBOR_VERSION_FRESH_MS = 24 * 60 * 60 * 1000

export interface HarborObservation {
  version: string | null
  seenAt: Date | null
  /** False when the reading is older than HARBOR_VERSION_FRESH_MS, or absent. */
  fresh: boolean
}

export function readHarborObservation(
  registry: { harborVersion: string | null; harborVersionSeenAt: Date | null },
  now: Date = new Date(),
): HarborObservation {
  const seenAt = registry.harborVersionSeenAt
  return {
    version: registry.harborVersion,
    seenAt,
    fresh: seenAt !== null && now.getTime() - seenAt.getTime() < HARBOR_VERSION_FRESH_MS,
  }
}

/**
 * Persists a version reading, if it is one, and if it still applies.
 *
 * Deliberately not called from checkRegistryHealth(): that probe also serves connections that
 * have no row at all — the "Test connection" button posts a form, id included but baseUrl edited
 * — and a probe must not write. Callers that know they hold a stored registry call this.
 */
export async function recordHarborObservation(
  registry: { id: string; baseUrl: string },
  health: RegistryHealth,
  now: Date = new Date(),
): Promise<void> {
  if (!registry.id) return
  if (!health.harbor || !health.version) return

  // updateMany, not update: the baseUrl condition makes the write a no-op when the row has moved
  // on, and update() would throw on a row that no longer matches.
  await prisma.registry.updateMany({
    where: { id: registry.id, baseUrl: registry.baseUrl },
    data: { harborVersion: health.version, harborVersionSeenAt: now },
  })
}

/** Fire-and-forget variant for render paths: a failed cache write must never fail a page. */
export function recordHarborObservationInBackground(
  registry: { id: string; baseUrl: string },
  health: RegistryHealth,
): void {
  void recordHarborObservation(registry, health).catch(() => undefined)
}
