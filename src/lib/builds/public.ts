import type { BuildRun, ScheduledBuild } from "@/generated/prisma/client"
import type { BuildInput } from "./schema"
import { nextRunAt } from "@/lib/mirrors/cron"

export function publicBuild(row: ScheduledBuild & { project?: { name: string }; runs?: BuildRun[] }) {
  return { id: row.id, ...JSON.parse(row.config) as BuildInput, projectName: row.project?.name ?? row.projectId,
    enabled: row.enabled, applied: row.applied, deleting: row.deleting, lastError: row.lastError,
    appliedRevisionId: row.appliedRevisionId, lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
    nextRunAt: row.enabled && row.applied ? nextRunAt(row.schedule)?.toISOString() ?? null : null,
    runs: row.runs?.map(publicRun) ?? [],
  }
}
export function publicRun(row: BuildRun) {
  return { ...row, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null }
}
export type PublicBuild = ReturnType<typeof publicBuild>
