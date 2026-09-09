import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { Session } from "next-auth"
import { prisma } from "@/lib/prisma"
import { getConfig } from "@/lib/config"
import { AuthError } from "@/lib/auth/guard"
import { decryptSecret } from "@/lib/crypto"
import { pickWriteMember, toMember } from "@/lib/clusters/members"
import { resolveJobCaPem } from "@/lib/settings/enterprise-ca"
import { buildInputSchema, type BuildInput } from "./schema"
import { loadBuild, projectScope, requireBuildScope } from "./access"
import { publicBuild } from "./public"
import { BUILD_LABEL, buildJobSpec, buildName, labelsFor, revisionSecret } from "./job-spec"
import { createObject, listObjects, patchObject, readObject, removeObject, type KubeObject } from "./k8s"

const ownership = new AsyncLocalStorage<boolean>()
export async function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  if (ownership.getStore()) return fn()
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(742020, 1) AS acquired`
    if (!row.acquired) throw new AuthError("Build maintenance is busy; retry shortly", 409)
    return ownership.run(true, fn)
  }, { timeout: 120000, maxWait: 5000 })
}
export function requireBuildEnabled() {
  const c = getConfig()
  if (!c.buildsBetaEnabled || !c.k8sEnabled) throw new AuthError("Scheduled builds require BUILDS_BETA_ENABLED and K8S_ENABLED", 503)
  if (!c.buildsRunnerImage) throw new AuthError("Configure BUILDS_RUNNER_IMAGE with a pinned runner digest", 503)
}
export async function listBuilds(session: Session) {
  const rows = await prisma.scheduledBuild.findMany({ where: projectScope(session), include: { project: { select: { name: true } }, runs: { orderBy: { createdAt: "desc" }, take: 5 } }, orderBy: { name: "asc" } })
  return rows.map(publicBuild)
}
export async function buildMaterial(projectId: string, registryId?: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { robotAccounts: { orderBy: { createdAt: "desc" }, include: { placements: true } } } })
  if (!project || project.status !== "ACTIVE") throw new AuthError("Destination project must be active", 409)
  // An installed revision keeps its destination. A temporary health-check failure must
  // not permanently suspend a standing schedule; the pod reports connection failures.
  const registry = registryId ? await prisma.registry.findUnique({ where: { id: registryId } }) : null
  const member = registryId
    ? registry && registry.clusterId === project.clusterId && registry.role === "MANAGED" ? toMember(registry) : null
    : await pickWriteMember(project.clusterId, project.id)
  if (!member) throw new AuthError("The destination Harbor is no longer in this project's cluster; reapply this build", 409)
  if (member.conn.insecureTLS || !member.conn.baseUrl.startsWith("https://")) throw new AuthError("Builds require a destination with verified HTTPS", 400)
  const robot = project.robotAccounts.find((r) => !r.expiresAt || r.expiresAt > new Date())
  if (!robot) throw new AuthError("Create a project robot account before applying this build", 409)
  const encrypted = robot.placements.find((p) => p.registryId === member.registryId)?.encryptedSecret ?? robot.encryptedSecret
  const ca = await resolveJobCaPem()
  const fingerprint = createHash("sha256").update(JSON.stringify([member.registryId, robot.id, encrypted, ca])).digest("hex")
  return { project, member, robot, ca, fingerprint, password: decryptSecret(encrypted), username: `robot$${project.name}+${robot.name}` }
}
async function activeProject(projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } })
  if (p?.status !== "ACTIVE") throw new AuthError("Destination project must be active", 409)
}
export async function saveBuild(input: BuildInput, session: Session, id?: string) {
  requireBuildEnabled(); requireBuildScope(session, input.projectId)
  return withBuildLock(async () => {
    if (id) {
      const old = await loadBuild(id, session)
      if (old.deleting) throw new AuthError("Build deletion is pending", 409)
      if (old.projectId !== input.projectId || old.targetRepo !== input.targetRepo || old.tag !== input.tag) throw new AuthError("Recreate the build to change its destination", 400)
      await suspendBuild(id)
    }
    await activeProject(input.projectId)
    const data = { name: input.name, projectId: input.projectId, targetRepo: input.targetRepo, tag: input.tag, config: JSON.stringify(input), schedule: input.schedule, enabled: input.enabled, applied: false }
    const row = id ? await prisma.scheduledBuild.update({ where: { id }, data }) : await prisma.scheduledBuild.create({ data: { ...data, createdByUserId: session.user.id } })
    return applyBuild(row.id)
  })
}
export async function suspendBuild(id: string) {
  if (!getConfig().k8sEnabled) throw new AuthError("Kubernetes is disabled; the existing schedule cannot be changed", 503)
  if (await readObject("cronjobs", buildName(id))) await patchObject("cronjobs", buildName(id), { spec: { suspend: true } })
}
export async function pauseBuild(id: string) {
  return withBuildLock(async () => {
    await suspendBuild(id)
    const row = await loadBuild(id)
    const config = buildInputSchema.parse(JSON.parse(row.config))
    return publicBuild(await prisma.scheduledBuild.update({ where: { id }, data: { enabled: false, config: JSON.stringify({ ...config, enabled: false }) } }))
  })
}
export async function applyBuild(id: string) {
  requireBuildEnabled()
  return withBuildLock(async () => {
    const row = await loadBuild(id)
    if (row.deleting) throw new AuthError("Build deletion is pending", 409)
    try {
      await suspendBuild(id)
      const config = buildInputSchema.parse(JSON.parse(row.config))
      const material = await buildMaterial(row.projectId)
      const destination = `${new URL(material.member.conn.baseUrl).host}/${material.project.name}/${row.targetRepo}:${row.tag}`
      const revision = await prisma.buildRevision.create({ data: { buildId: id, config: row.config, destination, registryId: material.member.registryId, robotId: material.robot.id, fingerprint: material.fingerprint } })
      const labels = labelsFor(id, revision.id)
      await createObject("secrets", { apiVersion: "v1", kind: "Secret", immutable: true, metadata: { name: revisionSecret(revision.id), labels }, type: "Opaque", stringData: {
        "config.json": JSON.stringify({ ...config, destination }),
        "auth.json": JSON.stringify({ auths: { [new URL(material.member.conn.baseUrl).host]: { auth: Buffer.from(`${material.username}:${material.password}`).toString("base64") } } }),
        "ca.crt": material.ca ?? "",
      } })
      const spec = { schedule: row.schedule, timeZone: "Etc/UTC", suspend: !row.enabled, concurrencyPolicy: "Forbid", startingDeadlineSeconds: 300,
        successfulJobsHistoryLimit: 10080, failedJobsHistoryLimit: 10080,
        jobTemplate: { metadata: { labels }, spec: buildJobSpec(id, revision.id, getConfig()) } }
      if (await readObject("cronjobs", buildName(id))) await patchObject("cronjobs", buildName(id), { spec })
      else await createObject("cronjobs", { apiVersion: "batch/v1", kind: "CronJob", metadata: { name: buildName(id), labels }, spec })
      await prisma.scheduledBuild.update({ where: { id }, data: { applied: true, appliedRevisionId: revision.id, lastAppliedAt: new Date(), lastError: null } })
    } catch (err) {
      await prisma.scheduledBuild.update({ where: { id }, data: { applied: false, lastError: err instanceof Error ? err.message : "Build installation failed" } })
    }
    return publicBuild(await loadBuild(id))
  })
}
export async function runBuild(id: string) {
  requireBuildEnabled()
  return withBuildLock(async () => {
    const row = await loadBuild(id)
    if (row.deleting || !row.applied || !row.appliedRevisionId) throw new AuthError("Apply this build before running it", 409)
    const rev = await prisma.buildRevision.findUniqueOrThrow({ where: { id: row.appliedRevisionId } })
    const material = await buildMaterial(row.projectId, rev.registryId)
    if (material.fingerprint !== rev.fingerprint) { await invalidateBuild(id, "Credentials or CA changed; reapply this build"); throw new AuthError("Reapply this build after credential or CA rotation", 409) }
    const jobs = await listObjects("jobs", `${BUILD_LABEL}=${id}`)
    if (jobs.some((j) => !j.status?.conditions?.some((c) => ["Complete", "Failed"].includes(c.type) && c.status === "True"))) throw new AuthError("A build is already active", 409)
    const run = await prisma.buildRun.create({ data: { buildId: id, revisionId: rev.id, origin: "manual", jobName: `${buildName(id)}-${Date.now().toString(36)}` } })
    try {
      const job = await createObject("jobs", { apiVersion: "batch/v1", kind: "Job", metadata: { name: run.jobName, labels: labelsFor(id, rev.id) }, spec: buildJobSpec(id, rev.id, getConfig()) }) as KubeObject
      await prisma.buildRun.update({ where: { id: run.id }, data: { jobUid: job.metadata.uid } })
    } catch {
      // A timeout may follow a successful creation. Keep the row pending for reconciliation.
      await prisma.buildRun.update({ where: { id: run.id }, data: { error: "Job creation unconfirmed; reconciliation will check the cluster" } })
    }
    return { runId: run.id }
  })
}
export async function invalidateBuild(id: string, reason: string) {
  await suspendBuild(id)
  await prisma.scheduledBuild.update({ where: { id }, data: { applied: false, lastError: reason } })
}
export async function deleteBuild(id: string) {
  return withBuildLock(async () => {
    await prisma.scheduledBuild.update({ where: { id }, data: { deleting: true, enabled: false } })
    try {
      await suspendBuild(id)
      await removeObject("cronjobs", buildName(id))
      const jobs = await listObjects("jobs", `${BUILD_LABEL}=${id}`)
      for (const job of jobs) await removeObject("jobs", job.metadata.name, job.metadata.uid)
      if ((await listObjects("pods", `${BUILD_LABEL}=${id}`)).length || (await listObjects("jobs", `${BUILD_LABEL}=${id}`)).length || await readObject("cronjobs", buildName(id))) return false
      const revisions = await prisma.buildRevision.findMany({ where: { buildId: id } })
      for (const revision of revisions) await removeObject("secrets", revisionSecret(revision.id))
      await removeObject("leases", buildName(id))
      await prisma.buildRun.deleteMany({ where: { buildId: id } })
      await prisma.scheduledBuild.delete({ where: { id } })
      return true
    } catch (err) {
      await prisma.scheduledBuild.update({ where: { id }, data: { lastError: err instanceof Error ? err.message : "Cleanup pending" } })
      return false
    }
  })
}
export async function blockProjectBuilds(projectId: string) {
  const rows = await prisma.scheduledBuild.findMany({ where: { projectId }, select: { name: true } })
  if (rows.length) throw new AuthError(`Remove scheduled builds first: ${rows.map((r) => r.name).join(", ")}`, 409)
}

export async function invalidateProjectBuilds(projectId: string | undefined, reason: string) {
  const rows = await prisma.scheduledBuild.findMany({ where: { ...(projectId ? { projectId } : {}), applied: true } })
  for (const row of rows) await invalidateBuild(row.id, reason)
}
