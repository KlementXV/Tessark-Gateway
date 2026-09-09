// Applying a storage quota to a project, extracted from the PUT route because two callers
// now perform the exact same write: an admin editing the quota directly, and an admin
// approving a QuotaRequest a project manager raised. Approving must land the same value
// through the same fan-out and the same rollback rules — not a second, subtly different
// implementation of them.
import { prisma } from "@/lib/prisma"
import { syncQuotaAcrossCluster } from "@/lib/clusters/quota"

/**
 * A storage limit as a bare binary-prefixed size — "50 GiB", or "∞" for no limit.
 *
 * Deliberately not localized: its two callers are the requests queue, whose subtitles are
 * data rather than prose and never go through next-intl, and the notification payload, which
 * is read back in whatever language the recipient uses. A digit and a IEC unit mean the same
 * thing in both catalogues; a word would not.
 */
export function formatQuotaMib(mib: number | null): string {
  if (mib === null) return "∞"
  const units = ["MiB", "GiB", "TiB", "PiB"]
  let value = mib
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`
}

export class QuotaUpdateError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface QuotaUpdateResult {
  storageQuotaMib: number | null
  placements: {
    succeeded: number
    failed: number
    failures: { registry: string; error: string | undefined }[]
  }
}

/**
 * Records `storageQuotaMib` as the project's desired state and pushes it to every member
 * Harbor. The row is written *before* the fan-out so that a member which is down replays the
 * value being set now, not the one it replaced; it is put back if nothing anywhere took it.
 *
 * Throws QuotaUpdateError (400 for a project that isn't active, 502 for a fan-out that
 * reached nobody) — the callers map that straight onto their response.
 */
export async function applyProjectQuota(
  projectId: string,
  storageQuotaMib: number | null,
): Promise<QuotaUpdateResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, storageQuotaMib: true },
  })
  if (!project) throw new QuotaUpdateError("Not found", 404)
  if (project.status !== "ACTIVE") {
    throw new QuotaUpdateError("Project must be active before setting a quota", 400)
  }

  const previous = project.storageQuotaMib
  await prisma.project.update({ where: { id: projectId }, data: { storageQuotaMib } })

  let summary
  try {
    summary = await syncQuotaAcrossCluster(projectId, storageQuotaMib)
  } catch (err) {
    await prisma.project.update({ where: { id: projectId }, data: { storageQuotaMib: previous } })
    throw new QuotaUpdateError(
      err instanceof Error ? err.message : "Failed to update quota",
      502,
    )
  }

  if (summary.succeeded === 0) {
    // Nothing took it and nothing will replay it on a Harbor that rejected it on merit, so
    // the recorded desired state is put back rather than left claiming a limit that exists
    // nowhere.
    await prisma.project.update({ where: { id: projectId }, data: { storageQuotaMib: previous } })
    const detail = summary.outcomes.map((o) => `${o.member.registryName}: ${o.error}`).join("; ")
    throw new QuotaUpdateError(`No Harbor in the cluster accepted the quota — ${detail}`, 502)
  }

  return {
    storageQuotaMib,
    placements: {
      succeeded: summary.succeeded,
      failed: summary.failed,
      failures: summary.outcomes
        .filter((o) => !o.ok)
        .map((o) => ({ registry: o.member.registryName, error: o.error })),
    },
  }
}
