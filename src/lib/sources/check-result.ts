// The shape POST /api/sources/check returns. Kept apart from ./check so client components can
// import the type without pulling undici into the bundle — same split as registries/health.

export interface SourceProbeResult {
  repo: string
  ok: boolean
  tagCount?: number
  error?: string
}

export interface SourceCheckResult {
  /** The v2 API base actually probed — not always `https://<host>`, see registryApiBase. */
  base: string
  reachable: boolean
  status?: number
  /** True only when a scoped read of a real repository succeeded. */
  authenticated: boolean
  probe: SourceProbeResult | null
  error?: string
  durationMs: number
}

export type SourceCheckVerdict = "ok" | "reachable" | "denied" | "unreachable"

// One word for the badge, so the form and any future list agree on what a result means.
export function verdictOf(result: SourceCheckResult): SourceCheckVerdict {
  if (!result.reachable) return "unreachable"
  if (result.authenticated) return "ok"
  if (result.probe && !result.probe.ok) return "denied"
  return "reachable"
}
