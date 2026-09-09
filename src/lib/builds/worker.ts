import type { BuildRun } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getConfig } from "@/lib/config"
import { logger } from "@/lib/logger"
import { BUILD_LABEL, REVISION_LABEL, buildName, revisionSecret } from "./job-spec"
import { listObjects, readObject, removeObject, terminalJob, type KubeObject } from "./k8s"
import { buildMaterial, deleteBuild, invalidateBuild, withBuildLock } from "./service"

export function runOutcome(job: KubeObject, pods: KubeObject[]) {
  const terminal = terminalJob(job)
  const pod = pods.find((p) => p.status?.containerStatuses?.some((c) => c.name === "build"))
  const termination = pod?.status?.containerStatuses?.find((c) => c.name === "build")?.state?.terminated
  let result: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(termination?.message ?? "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed as Record<string, unknown>
  } catch { /* no runner result, e.g. OOM */ }
  let status = terminal ?? (pods.some((p) => p.status?.phase === "Running") ? "running" : "pending")
  if (terminal === "succeeded") status = result.status === "skipped" ? "skipped" : result.status === "succeeded" && /^sha256:[a-f0-9]{64}$/.test(String(result.digest)) ? "succeeded" : "unknown"
  const text = (key: string, max: number) => typeof result[key] === "string" ? result[key].slice(0, max) : null
  return { status, commit: text("commit", 64), digest: text("digest", 80), stage: text("stage", 32),
    error: text("error", 500) ?? (terminal === "failed" ? termination?.reason ?? "Job failed before producing a result" : status === "unknown" ? "Job completed without a verifiable publication result" : null),
    startedAt: job.status?.startTime ? new Date(job.status.startTime) : null,
    completedAt: terminal ? new Date(job.status?.completionTime ?? Date.now()) : null,
  }
}
export function retainRunOutcome(data: ReturnType<typeof runOutcome> & { jobUid: string }, existing: Pick<BuildRun, "jobUid" | "completedAt" | "digest" | "commit" | "stage" | "status" | "error"> | null) {
  const retained = { ...data }
  if (existing?.jobUid !== data.jobUid) return retained
  if (existing.completedAt && retained.completedAt) retained.completedAt = existing.completedAt
  // Pods can expire before Jobs. Retain a collected publication result independently.
  retained.digest ??= existing.digest
  retained.commit ??= existing.commit
  retained.stage ??= existing.stage
  if (retained.status === "unknown" && ["succeeded", "failed", "skipped", "cancelled"].includes(existing.status)) {
    retained.status = existing.status
    retained.error = existing.error
  }
  return retained
}

export async function collectBuilds() {
  if (!getConfig().k8sEnabled) return
  await withBuildLock(async () => {
    const rows = await prisma.scheduledBuild.findMany()
    for (const row of rows) {
      if (row.deleting) { await deleteBuild(row.id); continue }
      try {
        if (!row.applied) {
          const { suspendBuild } = await import("./service")
          await suspendBuild(row.id)
        }
        if (!getConfig().buildsBetaEnabled && row.applied) await invalidateBuild(row.id, "Build beta disabled; reapply after enabling it")
        else if (row.applied && row.appliedRevisionId) {
          const rev = await prisma.buildRevision.findUnique({ where: { id: row.appliedRevisionId } })
          try {
            const material = await buildMaterial(row.projectId, rev?.registryId)
            if (!rev || material.fingerprint !== rev.fingerprint) await invalidateBuild(row.id, "Destination credentials or CA changed; reapply this build")
          } catch { await invalidateBuild(row.id, "Destination is no longer ready; reapply this build") }
        }
        const jobs = await listObjects("jobs", `${BUILD_LABEL}=${row.id}`)
        // Read the Lease BEFORE the pod snapshot. Otherwise a new pod could claim it
        // between listing pods and reading the Lease, and look falsely absent.
        const lease = await readObject<KubeObject>("leases", buildName(row.id))
        const pods = await listObjects("pods", `${BUILD_LABEL}=${row.id}`)
        for (const job of jobs) {
          const revisionId = job.metadata.labels?.[REVISION_LABEL]
          if (!revisionId || !await prisma.buildRevision.findFirst({ where: { id: revisionId, buildId: row.id } })) continue
          const outcome = runOutcome(job, pods.filter((p) => p.metadata.labels?.["job-name"] === job.metadata.name))
          const data = { ...outcome, jobUid: job.metadata.uid }
          // Preserve the first observed completion time when Kubernetes does not provide one.
          const existing = await prisma.buildRun.findUnique({ where: { jobName: job.metadata.name } })
          const retained = retainRunOutcome(data, existing)

          await prisma.buildRun.upsert({ where: { jobName: job.metadata.name }, create: { ...retained, buildId: row.id, revisionId, jobName: job.metadata.name, origin: "schedule" }, update: retained })
        }
        const pending = await prisma.buildRun.findMany({ where: { buildId: row.id, status: { in: ["pending", "running"] }, createdAt: { lt: new Date(Date.now() - 60000) } } })
        for (const run of pending) if (!jobs.some((j) => j.metadata.name === run.jobName)) await prisma.buildRun.update({ where: { id: run.id }, data: { status: "unknown", completedAt: new Date(), error: "Job is absent; its result could not be collected" } })
        if (lease) {
          const owner = pods.find((p) => p.metadata.uid === lease.spec?.holderIdentity)
          // Never release based on a timeout, Job deletion request, or a failed API read.
          if (!owner || ["Succeeded", "Failed"].includes(owner.status?.phase ?? "")) await removeObject("leases", buildName(row.id), lease.metadata.uid)
        }
        const cron = await readObject<{ spec?: { jobTemplate?: { metadata?: { labels?: Record<string, string> } } } }>("cronjobs", buildName(row.id))
        const liveRevision = cron?.spec?.jobTemplate?.metadata?.labels?.[REVISION_LABEL]
        if (!cron && row.applied) await prisma.scheduledBuild.update({ where: { id: row.id }, data: { applied: false, lastError: "CronJob is missing; reapply this build" } })
        const revisions = await prisma.buildRevision.findMany({ where: { buildId: row.id, id: { not: row.appliedRevisionId ?? "" } } })
        // Allow controller caches and pending schedules to settle before collecting old
        // snapshots. Recent applies must not race a CronJob controller creating an old Job.
        const quiet = row.lastAppliedAt && Date.now() - row.lastAppliedAt.getTime() > getConfig().buildsJobTtlSeconds * 1000
        for (const rev of revisions) if (quiet && rev.id !== liveRevision && !jobs.some((j) => j.metadata.labels?.[REVISION_LABEL] === rev.id) && !pods.some((p) => p.metadata.labels?.[REVISION_LABEL] === rev.id)) await removeObject("secrets", revisionSecret(rev.id))
      } catch (err) { logger.warn("Build reconciliation deferred", { buildId: row.id, error: err instanceof Error ? err.message : "Unavailable" }) }
    }
    const cutoff = new Date(Date.now() - getConfig().buildsRetentionDays * 86400000)
    await prisma.buildRun.deleteMany({ where: { completedAt: { lt: cutoff } } })

  })
}
const state = globalThis as typeof globalThis & { buildWorkerStarted?: boolean }
export function startBuildWorker() {
  if (state.buildWorkerStarted || !getConfig().k8sEnabled) return
  state.buildWorkerStarted = true
  const tick = async () => {
    try { await collectBuilds() } catch (err) { logger.warn("Build collector deferred", { error: err instanceof Error ? err.message : "Unavailable" }) }
    setTimeout(tick, getConfig().buildsPollSeconds * 1000).unref()
  }
  setTimeout(tick, 2000).unref()
}
