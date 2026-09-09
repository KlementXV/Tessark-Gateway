// In-memory token bucket, one entry per rate-limit key (an ApiToken id, or an IP address
// before a token resolves — see resolveApiToken). Deliberately not shared across replicas:
// same accepted limitation as the k8s client's ServiceAccount token cache (CLAUDE.md §7) — a
// caller can consume up to limit × replicaCount before being throttled. Revisit with a
// shared store (Redis) only if that turns out to matter in practice.
import { getConfig } from "@/lib/config"

const WINDOW_MS = 60_000
// Crude memory bound for a map keyed partly by client IP, which an attacker could otherwise
// grow without limit by rotating addresses. Real tokens are few and never trigger this.
const MAX_TRACKED_KEYS = 10_000

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the current window resets — meaningful only when `allowed` is false. */
  retryAfterSeconds: number
}

/**
 * Makes room in the map when it hits its bound, without ever resetting a counter that is
 * still doing its job.
 *
 * Expired windows go first, because they are dead weight by definition. Only if that frees
 * nothing — a genuine flood of distinct keys inside a single window — are the oldest entries
 * dropped. What this must never do is empty the map wholesale: the keys are partly client IPs
 * (see clientIp, which trusts a header anyone can forge), so a caller who rotates that header
 * enough times would otherwise clear the buckets of every real token along with their own and
 * hand themselves an unlimited rate.
 */
function evict(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) buckets.delete(key)
  }
  if (buckets.size < MAX_TRACKED_KEYS) return

  const oldestFirst = [...buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)
  for (const [key] of oldestFirst.slice(0, Math.ceil(MAX_TRACKED_KEYS / 10))) {
    buckets.delete(key)
  }
}

export function checkRateLimit(key: string): RateLimitResult {
  const limit = getConfig().apiRateLimitPerMinute
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    if (buckets.size >= MAX_TRACKED_KEYS) evict(now)
    buckets.set(key, { count: 1, windowStart: now })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  bucket.count += 1
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

/** Best-effort client address for the pre-token-resolution bucket — trusts the proxy's header. */
export function clientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")
  if (forwardedFor) return forwardedFor.split(",")[0].trim()
  return "unknown"
}
