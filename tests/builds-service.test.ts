// This file runs in its own process, so the memoized configuration can test enabled paths.
// eslint-disable-next-line no-restricted-syntax
process.env.BUILDS_BETA_ENABLED = "true"
// eslint-disable-next-line no-restricted-syntax
process.env.K8S_ENABLED = "true"
// eslint-disable-next-line no-restricted-syntax
process.env.BUILDS_RUNNER_IMAGE = `example/runner@sha256:${"a".repeat(64)}`
import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { prisma } from "../src/lib/prisma"
import { blockProjectBuilds, deleteBuild, withBuildLock, buildMaterial } from "../src/lib/builds/service"

const restore: Array<() => void> = []
function stub(target: object, name: string, implementation: (...args: never[]) => unknown) {
  const obj = target as Record<string, unknown>; const original = obj[name]
  obj[name] = mock.fn(implementation); restore.push(() => { obj[name] = original })
}
afterEach(() => { while (restore.length) restore.pop()!() })

test("configuration mutations refuse to proceed when another replica owns the lock", async () => {
  stub(prisma, "$transaction", async (fn: (tx: object) => Promise<unknown>) => fn({ $queryRaw: async () => [{ acquired: false }] }))
  let called = false
  await assert.rejects(withBuildLock(async () => { called = true }), /busy/)
  assert.equal(called, false)
})
test("the configuration lock is reentrant for apply, cleanup and rotation", async () => {
  let acquired = 0
  stub(prisma, "$transaction", async (fn: (tx: object) => Promise<unknown>) => { acquired++; return fn({ $queryRaw: async () => [{ acquired: true }] }) })
  assert.equal(await withBuildLock(() => withBuildLock(async () => 42)), 42)
  assert.equal(acquired, 1)
})
test("project deletion is blocked even for paused build definitions", async () => {
  stub(prisma.scheduledBuild, "findMany", async () => [{ name: "weekly-build" }])
  await assert.rejects(blockProjectBuilds("project"), /weekly-build/)
})
test("an unreachable Kubernetes API retains deletion intent instead of forgetting a live schedule", async () => {
  stub(prisma, "$transaction", async (fn: (tx: object) => Promise<unknown>) => fn({ $queryRaw: async () => [{ acquired: true }] }))
  const updates: Array<{ data: Record<string, unknown> }> = []
  stub(prisma.scheduledBuild, "update", async (args: { data: Record<string, unknown> }) => { updates.push(args); return {} })
  // The fixture runs outside a Kubernetes pod: suspend fails before any database deletion.
  let deleted = false
  stub(prisma.scheduledBuild, "delete", async () => { deleted = true })
  assert.equal(await deleteBuild("build"), false)
  assert.equal(deleted, false)
  assert.equal(updates[0].data.deleting, true)
  assert.equal(updates[0].data.enabled, false)
  assert.equal(typeof updates[1].data.lastError, "string")
})
test("inactive projects fail before selecting credentials or creating a system robot", async () => {
  stub(prisma.project, "findUnique", async () => ({ status: "PENDING" }))
  await assert.rejects(buildMaterial("project"), /must be active/)
})
