import assert from "node:assert/strict"
import { test } from "node:test"
import { buildInputSchema } from "../src/lib/builds/schema"
import { isValidSchedule, nextRunAt } from "../src/lib/mirrors/cron"
import { buildJobSpec } from "../src/lib/builds/job-spec"
import { getConfig } from "../src/lib/config"
import { runOutcome, retainRunOutcome } from "../src/lib/builds/worker"
import { requireBuildScope, projectScope } from "../src/lib/builds/access"
import type { KubeObject } from "../src/lib/builds/k8s"
import type { Session } from "next-auth"

const input = { name: "weekly-base", projectId: "project", targetRepo: "base/alpine", sourceKind: "inline", dockerfileContent: "FROM scratch", schedule: "0 3 * * 1" }
test("build sources are exclusive and Git inputs cannot become shell/options/paths", () => {
  assert.equal(buildInputSchema.parse(input).tag, "latest")
  for (const change of [
    { sourceKind: "git" }, { gitUrl: "https://github.com/a/b" }, { dockerfileContent: "" },
    { contextPath: "../private" }, { contextPath: "/etc" }, { dockerfilePath: "a/../secret" },
    { buildArgs: { TOKEN: "x".repeat(2049) } }, { targetRepo: "A;env" }, { tag: "foo/bar" },
  ]) assert.equal(buildInputSchema.safeParse({ ...input, ...change }).success, false)
  const git = { ...input, sourceKind: "git", dockerfileContent: "", gitUrl: "https://github.com/org/repo.git", gitRef: "main" }
  assert.equal(buildInputSchema.safeParse(git).success, true)
  for (const gitUrl of ["file:///etc", "http://host/repo", "https://user:password@host/repo", "https://host/repo?token=secret", "https://host/repo#main"]) assert.equal(buildInputSchema.safeParse({ ...git, gitUrl }).success, false)
  for (const gitRef of ["--upload-pack=evil", "a..b", "main;id", "$(id)", "a//b"]) assert.equal(buildInputSchema.safeParse({ ...git, gitRef }).success, false)
})
test("cron validation checks bounds and malformed steps, without rejecting leap days", () => {
  for (const cron of ["99 3 * * *", "0 24 * * *", "*/0 * * * *", "1//2 * * * *", "3-2 * * * *", "1-2-3 * * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8"]) assert.equal(isValidSchedule(cron), false, cron)
  for (const cron of ["0 * * * *", "0 3 * * 1", "0 3 1 * *", "*/15 1-5 * * 0,6", "0 0 29 2 *"]) assert.equal(isValidSchedule(cron), true, cron)
  assert.equal(nextRunAt("0 3 * * 1", new Date("2026-09-07T03:00:00Z"))?.toISOString(), "2026-09-14T03:00:00.000Z")
})
test("build spec isolates credentials, bounds resources and pins the runner", () => {
  const config = { ...getConfig(), buildsRunnerImage: `example/runner@sha256:${"a".repeat(64)}` }
  const spec = buildJobSpec("build-id", "revision-id", config)
  const pod = spec.template.spec
  assert.equal(pod.automountServiceAccountToken, false)
  assert.equal(spec.backoffLimit, 0)
  assert.equal(spec.activeDeadlineSeconds, 1800)
  assert.ok(pod.initContainers[0].volumeMounts.some((v) => v.name === "kube"))
  assert.ok(!pod.containers[0].volumeMounts.some((v) => v.name === "kube"))
  assert.ok(!pod.initContainers[0].volumeMounts.some((v) => v.name === "config"))
  assert.equal(pod.containers[0].securityContext.privileged, false)
  assert.ok(!JSON.stringify(spec).includes("hostPath"))
  assert.ok(JSON.stringify(spec).includes("build-rev-revision-id"))
  assert.throws(() => buildJobSpec("id", "rev", { ...config, buildsRunnerImage: undefined }))
})
const job = (conditions: Array<{ type: string; status: string }>): KubeObject => ({ metadata: { name: "job", uid: "uid" }, status: { conditions } })
const pod = (result: unknown): KubeObject => ({ metadata: { name: "pod", uid: "pod" }, status: { phase: "Succeeded", containerStatuses: [{ name: "build", state: { terminated: { message: JSON.stringify(result) } } }] } })
test("success requires a terminal Job and a verifiable push result", () => {
  const complete = job([{ type: "Complete", status: "True" }])
  assert.equal(runOutcome(complete, []).status, "unknown")
  assert.equal(runOutcome(complete, [pod(null)]).status, "unknown")
  assert.equal(runOutcome(complete, [pod({ status: "succeeded", digest: "invalid" })]).status, "unknown")
  assert.equal(runOutcome(complete, [pod({ status: "succeeded", digest: `sha256:${"a".repeat(64)}` })]).status, "succeeded")
  assert.equal(runOutcome(complete, [pod({ status: "skipped" })]).status, "skipped")
  assert.equal(runOutcome(job([{ type: "Failed", status: "False" }]), []).status, "pending")
  const failed = runOutcome(job([{ type: "Failed", status: "True" }]), [pod({ status: "failed", stage: "push", error: "Push refused" })])
  assert.equal(failed.status, "failed"); assert.equal(failed.stage, "push")
})
test("project-scoped tokens fail closed and do not inherit admin cross-project access", () => {
  const session: Session = { user: { id: "admin", role: "ADMIN" }, expires: "2099-01-01", buildProjectScope: ["one"] }
  requireBuildScope(session, "one")
  assert.throws(() => requireBuildScope(session, "two"))
  assert.deepEqual(projectScope(session), { projectId: { in: ["one"] } })
  assert.throws(() => requireBuildScope({ ...session, buildProjectScope: [] }, "one"))
})

test("collected publication results survive pod expiry without leaking across Job UIDs", () => {
  const existing = { jobUid: "uid", completedAt: new Date("2026-09-08T00:00:00Z"), status: "succeeded", digest: `sha256:${"a".repeat(64)}`, commit: "abc", stage: "push", error: null }
  const missingPod = { ...runOutcome(job([{ type: "Complete", status: "True" }]), []), jobUid: "uid" }
  const retained = retainRunOutcome(missingPod, existing)
  assert.equal(retained.status, "succeeded")
  assert.equal(retained.digest, existing.digest)
  assert.equal(retained.completedAt, existing.completedAt)
  assert.equal(retainRunOutcome({ ...missingPod, jobUid: "new-job" }, existing).digest, null)
})
