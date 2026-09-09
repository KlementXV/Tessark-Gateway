import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { prisma } from "../src/lib/prisma"
import { enqueue } from "../src/lib/clusters/fanout"
import { applyRobotToMember, loadRobotDesiredState } from "../src/lib/clusters/robots"
import { saveMemberAcrossCluster } from "../src/lib/clusters/project-members"
import { encryptSecret } from "../src/lib/crypto"
import { withTransferLock } from "../src/lib/transfers/lock"
import { ensureTransferResources, TransferJobUnconfirmedError } from "../src/lib/transfers/resources"
import type { ClusterMember } from "../src/lib/clusters/members"

const restore: Array<() => void> = []
function stub(target: object, name: string, implementation: (...args: never[]) => unknown) {
  const object = target as Record<string, unknown>
  const original = object[name]
  const fn = mock.fn(implementation)
  object[name] = fn
  restore.push(() => { object[name] = original })
  return fn
}
afterEach(() => { while (restore.length) restore.pop()!(); mock.restoreAll() })

for (const [add, remove, subject] of [
  ["MEMBER_ADD", "MEMBER_REMOVE", "username"],
  ["GROUP_ADD", "GROUP_REMOVE", "groupName"],
] as const) {
  test(`${remove} survives a pending role update and preserves other subjects`, async () => {
    let ops = [{ id: "a", kind: add, payload: JSON.stringify({ [subject]: "alice" }) }, { id: "b", kind: add, payload: JSON.stringify({ [subject]: "bob" }) }]
    stub(prisma.registry, "findUnique", async () => ({ role: "MANAGED" }))
    stub(prisma.pendingOperation, "findMany", async () => ops)
    stub(prisma.pendingOperation, "deleteMany", async ({ where }: { where: { id: { in: string[] } } }) => { ops = ops.filter((op) => !where.id.in.includes(op.id)); return { count: 1 } })
    const created = stub(prisma.pendingOperation, "create", async ({ data }: { data: object }) => data)
    await enqueue({ registryId: "r", projectId: "p", kind: remove, payload: { [subject]: "alice" } })
    assert.deepEqual(ops.map((op) => op.id), ["b"])
    assert.equal(created.mock.callCount(), 1)
    assert.equal((created.mock.calls[0].arguments[0] as { data: { kind: string } }).data.kind, remove)
  })
}
for (const kind of ["PROJECT_DELETE", "ROBOT_DELETE"] as const) {
  test(`${kind} is retained even if a previous creation is pending`, async () => {
    stub(prisma.registry, "findUnique", async () => ({ role: "MANAGED" }))
    stub(prisma.pendingOperation, "findFirst", async () => ({ id: "pending-create" }))
    stub(prisma.pendingOperation, "deleteMany", async () => ({ count: 1 }))
    const created = stub(prisma.pendingOperation, "create", async ({ data }: { data: object }) => data)
    await enqueue({ registryId: "r", projectId: "p", robotAccountId: "robot", kind, payload: { harborRobotId: 12, harborProjectId: 4 } })
    assert.equal(created.mock.callCount(), 1)
  })
}
const member: ClusterMember = { registryId: "r", registryName: "Harbor", role: "MANAGED", conn: { id: "r", name: "Harbor", baseUrl: "https://harbor.test", authType: "none", username: null, secret: null, insecureTLS: false } }
test("expired robot replay is discarded; unlimited and future robots retain their lifetime", async () => {
  const robot = { id: "robot", name: "ci", encryptedSecret: encryptSecret("test-only"), expiresAt: new Date(0) as Date | null, project: { name: "p", clusterId: "c" } }
  stub(prisma.robotAccount, "findUnique", async () => robot)
  assert.equal(await loadRobotDesiredState("robot"), null)
  robot.expiresAt = null
  assert.equal((await loadRobotDesiredState("robot"))!.desired.expiresInDays, null)
  robot.expiresAt = new Date(Date.now() + 86400000)
  assert.equal((await loadRobotDesiredState("robot"))!.desired.expiresInDays, 1)
  const http = mock.method(globalThis, "fetch", async () => { throw new Error("must not connect") })
  await assert.rejects(applyRobotToMember(member, { id: "robot", name: "ci", projectName: "p", secret: "test", expiresInDays: 0 }), /expired/)
  assert.equal(http.mock.callCount(), 0)
})

for (const existing of [true, false]) {
  test(`full Harbor outage ${existing ? "preserves an existing member and its retry" : "rolls back a new membership"}`, async () => {
    const row = { id: "m", projectId: "p", userId: "u", role: "GUEST", project: { name: "p", clusterId: "c" } }
    let reads = 0
    stub(prisma.projectMember, "findUnique", async () => ++reads === 1 && !existing ? null : row)
    stub(prisma.projectMember, "upsert", async () => row)
    const deleted = stub(prisma.projectMember, "delete", async () => row)
    stub(prisma.cluster, "findUnique", async () => ({ identityMode: "GATEWAY" }))
    stub(prisma.userClusterIdentity, "findUnique", async () => ({ harborUsername: "alice" }))
    stub(prisma.registry, "findMany", async () => [{ id: "r", name: "Harbor", baseUrl: "https://harbor.test", authType: "none", role: "MANAGED" }])
    stub(prisma.registry, "findUnique", async () => ({ role: "MANAGED" }))
    stub(prisma.projectPlacement, "findUnique", async () => ({ harborProjectId: 1 }))
    stub(prisma.pendingOperation, "findMany", async () => [])
    const queued = stub(prisma.pendingOperation, "create", async () => ({}))
    stub(prisma.pendingOperation, "deleteMany", async () => ({ count: 0 }))
    mock.method(globalThis, "fetch", async () => { throw new Error("Harbor offline") })
    const result = await saveMemberAcrossCluster("p", "u", "GUEST", "alice")
    assert.equal(result.summary.succeeded, 0)
    assert.equal(queued.mock.callCount(), 1)
    assert.equal(deleted.mock.callCount(), existing ? 0 : 1)
  })
}

test("concurrent transfer decisions cannot both enter the launch section", async () => {
  let busy = false
  stub(prisma, "$transaction", async (run: (tx: object) => Promise<unknown>) => {
    const owner = !busy
    if (owner) busy = true
    try { return await run({ $queryRaw: async () => [{ acquired: owner }] }) } finally { if (owner) busy = false }
  })
  let entered = 0
  await withTransferLock("t", async () => {
    entered++
    await assert.rejects(withTransferLock("t", async () => { entered++ }), /retry shortly/)
  })
  assert.equal(entered, 1)
  assert.equal(await withTransferLock("t", async () => 42), 42)
})

const resources = { jobName: "transfer-t", labels: { transfer: "t" }, spec: {}, secrets: [{ name: "transfer-t-creds", data: { password: "fixture" } }] }
function kubeFixture(options: { existingJob?: boolean; failPost?: boolean; failReadAfterPost?: boolean; foreign?: boolean; denied?: boolean } = {}) {
  let job = options.existingJob ?? false
  let secret = job
  let posted = false
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const object = (uid: string) => ({ metadata: { uid, labels: options.foreign ? { transfer: "other" } : resources.labels } })
  const request = async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = JSON.parse(String(init.body ?? "{}"))
    calls.push({ method, path, body })
    if (path.includes("/jobs")) {
      if (method === "POST") {
        posted = true
        if (options.denied) return new Response(null, { status: 403 })
        job = true
        if (options.failPost) throw new Error("response lost")
        return Response.json(object("job-uid"), { status: 201 })
      }
      if (posted && options.failReadAfterPost) throw new Error("offline")
      return job ? Response.json(object("job-uid")) : new Response(null, { status: 404 })
    }
    if (method === "POST") { secret = true; return Response.json(object("secret-uid"), { status: 201 }) }
    if (method === "PATCH") return Response.json(object("secret-uid"))
    return secret ? Response.json(object("secret-uid")) : new Response(null, { status: 404 })
  }
  return { request, calls }
}
test("a lost Job POST response adopts the created Job and never deletes credentials", async () => {
  const fixture = kubeFixture({ failPost: true })
  await ensureTransferResources(resources, fixture.request, "test")
  assert.equal(fixture.calls.filter((c) => c.method === "POST" && c.path.endsWith("/jobs")).length, 1)
  assert.equal(fixture.calls.some((c) => c.method === "DELETE"), false)
  const ownerPatch = fixture.calls.find((c) => c.method === "PATCH")!
  assert.deepEqual((ownerPatch.body.metadata as { ownerReferences: object[] }).ownerReferences, [{ apiVersion: "batch/v1", kind: "Job", name: "transfer-t", uid: "job-uid" }])
})
test("retry adopts a live Job without replacing its credentials or launching another", async () => {
  const fixture = kubeFixture({ existingJob: true })
  await ensureTransferResources(resources, fixture.request, "test")
  assert.equal(fixture.calls.some((c) => c.method === "POST" || c.method === "DELETE" || "stringData" in c.body), false)
})
test("a foreign Job is refused without any mutations", async () => {
  const fixture = kubeFixture({ existingJob: true, foreign: true })
  await assert.rejects(ensureTransferResources(resources, fixture.request, "test"), /another operation/)
  assert.equal(fixture.calls.every((c) => c.method === "GET"), true)
})
test("unreachable API after Job POST preserves credentials and reports an uncertain launch", async () => {
  const fixture = kubeFixture({ failPost: true, failReadAfterPost: true })
  await assert.rejects(ensureTransferResources(resources, fixture.request, "test"), TransferJobUnconfirmedError)
  assert.equal(fixture.calls.some((c) => c.method === "DELETE"), false)
})
test("a definite Job rejection remains an error with retryable credentials", async () => {
  const fixture = kubeFixture({ denied: true })
  await assert.rejects(ensureTransferResources(resources, fixture.request, "test"), /403/)
  assert.equal(fixture.calls.some((c) => c.method === "DELETE"), false)
})
