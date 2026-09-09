/** Bounded exponential backoff, shared by configuration, cleanup and copy retries. */
export function retryAt(attempts: number, now = Date.now()): Date {
  return new Date(now + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)))
}

export function executionOutcome(status: string, failed = 0): "running" | "succeeded" | "failed" {
  if (status === "Succeed") return failed > 0 ? "failed" : "succeeded"
  if (["Failed", "Stopped", "Error"].includes(status)) return "failed"
  return "running"
}
