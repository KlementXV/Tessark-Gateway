import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { prisma } from "../src/lib/prisma"
import { encryptSecret } from "../src/lib/crypto"
import { reconcileRegistry } from "../src/lib/clusters/reconcile"
import { advanceCatchUps } from "../src/lib/clusters/replication-catchup"
import { drainReplicationCleanup } from "../src/lib/clusters/replication-cleanup"
import { applyReplicationLink } from "../src/lib/clusters/replication"
import { withReplicationLock } from "../src/lib/clusters/replication-lock"
import { executionOutcome, retryAt } from "../src/lib/clusters/replication-retry"
import { createHarborRegistryEndpoint, updateHarborReplicationPolicy, triggerHarborReplication } from "../src/lib/registries/harbor"
import type { ClusterMember } from "../src/lib/clusters/members"

const conn = { id: "a", name: "A", baseUrl: "https://a.example.test", authType: "basic" as const, username: "admin", secret: "test", insecureTLS: false }
const registry = { id: "a", name: "A", baseUrl: conn.baseUrl, authType: "basic", username: "admin", encryptedSecret: null, insecureTLS: false, role: "MANAGED", clusterId: "cluster", systemRobotName: "robot$test", systemRobotSecret: encryptSecret("robot-secret") }
const source: ClusterMember = { registryId: "a", registryName: "A", role: "MANAGED", conn }
const dest: ClusterMember = { registryId: "b", registryName: "B", role: "MANAGED", conn: { ...conn, id: "b", baseUrl: "https://b.example.test" } }
function edge() {
  return { id: "edge", sourceRegistryId: "a", destRegistryId: "b", harborEndpointId: 10, harborPolicyId: 20, status: "ACTIVE", appliedFingerprint: null, catchUpRequested: true, executionId: null as number | null, lastExecutionId: null as number | null, executionStatus: null as string | null, executionError: null as string | null, lastCatchUpAt: null as Date | null, nextAttemptAt: new Date(0), attempts: 0 }
}
function copyFixture(link = edge()) {
  stub(prisma.cluster, "findUnique", async () => ({ id: "cluster", replicationMode: "event_based" }))
  stub(prisma.registry, "findUnique", async () => registry)
  stub(prisma.replicationLink, "findMany", async () => [link])
  stub(prisma.replicationLink, "update", async ({ data }: { data: Record<string, unknown> }) => {
    const { attempts, ...rest } = data
    Object.assign(link, rest)
    if (typeof attempts === "number") link.attempts = attempts
    else if (attempts) link.attempts++
    return link
  })
  return link
}
const restorers: Array<() => void> = []
function stub<T extends (...args: never[]) => unknown>(target: object, name: string, implementation: T) {
  const object = target as Record<string, unknown>
  const original = object[name]
  const fn = mock.fn(implementation)
  object[name] = fn
  restorers.push(() => { object[name] = original })
  return fn
}
afterEach(() => { for (const restore of restorers.splice(0).reverse()) restore(); mock.restoreAll() })

test("catch-up is only complete after Harbor reports a successful terminal execution", async () => {
  const link = copyFixture()
  const http = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === "POST") return new Response(null, { status: 201, headers: { location: "/api/v2.0/replication/executions/71" } })
    if (url.endsWith("/71")) return Response.json({ id: 71, status: "Succeed", failed: 0 })
    return Response.json([])
  })
  await advanceCatchUps("cluster")
  assert.equal(link.executionId, 71)
  assert.equal(link.lastCatchUpAt, null)
  assert.equal(link.catchUpRequested, false)
  await advanceCatchUps("cluster")
  assert.equal(link.executionId, null)
  assert.equal(link.lastExecutionId, 71)
  assert.ok((link.lastCatchUpAt as Date | null) instanceof Date)
  assert.equal(http.mock.calls.filter((call) => call.arguments[1]?.method === "POST").length, 1)
})

test("a failed copy remains requested and receives a delayed retry", async () => {
  const link = copyFixture({ ...edge(), executionId: 71, catchUpRequested: false })
  mock.method(globalThis, "fetch", async () => Response.json({ id: 71, status: "Failed", failed: 3 }))
  await advanceCatchUps("cluster")
  assert.equal(link.catchUpRequested, true)
  assert.equal(link.executionId, null)
  assert.equal(link.lastCatchUpAt, null)
  assert.equal(link.attempts, 1)
  assert.ok(link.nextAttemptAt.getTime() > Date.now())
  assert.match(link.executionError!, /3 failed tasks/)
})

test("a network failure while polling preserves execution identity across restarts", async () => {
  const link = copyFixture({ ...edge(), executionId: 71, catchUpRequested: false })
  const http = mock.method(globalThis, "fetch", async () => { throw new Error("network down") })
  await advanceCatchUps("cluster")
  assert.equal(link.executionId, 71)
  assert.equal(link.lastCatchUpAt, null)
  assert.equal(http.mock.callCount(), 1)
  assert.match(link.executionError!, /network down/)
})

test("a purged Harbor execution is retried instead of remaining stuck forever", async () => {
  const link = copyFixture({ ...edge(), executionId: 71, catchUpRequested: false })
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }))
  await advanceCatchUps("cluster")
  assert.equal(link.executionId, null)
  assert.equal(link.catchUpRequested, true)
  assert.equal(link.executionStatus, "Unknown")
})

test("a crash after dispatch adopts the running manual execution without another POST", async () => {
  const link = copyFixture()
  const http = mock.method(globalThis, "fetch", async () => Response.json([
    { id: 83, policy_id: 20, status: "InProgress", trigger: "manual" },
  ]))
  await advanceCatchUps("cluster")
  assert.equal(link.executionId, 83)
  assert.equal(http.mock.callCount(), 1)
  assert.notEqual(http.mock.calls[0].arguments[1]?.method, "POST")
})

test("periodic catch-up covers an outage with no administrative queue", async () => {
  const link = copyFixture({ ...edge(), catchUpRequested: false, lastCatchUpAt: new Date(0) })
  mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => init?.method === "POST"
    ? new Response(null, { status: 201, headers: { location: "/executions/90" } }) : Response.json([]))
  await advanceCatchUps("cluster")
  assert.equal(link.executionId, 90)
})

test("cleanup survives an unreachable source, then deletes policy before endpoint", async () => {
  const row = { id: "cleanup", sourceRegistryId: "a", destRegistryId: "b", encryptedConnection: encryptSecret(JSON.stringify(conn)), harborPolicyId: 20 as number | null, harborEndpointId: 10, attempts: 0 }
  stub(prisma.replicationCleanup, "findMany", async () => [row])
  stub(prisma.registry, "findUnique", async () => null)
  stub(prisma.replicationCleanup, "update", async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return row })
  const remove = stub(prisma.replicationCleanup, "delete", async () => row)
  const failed = mock.method(globalThis, "fetch", async () => { throw new Error("offline") })
  await drainReplicationCleanup()
  assert.equal(remove.mock.callCount(), 0)
  failed.mock.restore()
  const calls: string[] = []
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`)
    return init?.method ? new Response(null, { status: 200 }) : Response.json({ id: 20, enabled: true, name: String(input).includes("/registries/") ? "tessark-peer-b" : "tessark-replicate-b" })
  })
  await drainReplicationCleanup()
  assert.equal(remove.mock.callCount(), 1)
  assert.deepEqual(calls.map((call) => call.replace(conn.baseUrl, "")), [
    "GET /api/v2.0/replication/policies/20", "GET /api/v2.0/replication/policies/20", "PUT /api/v2.0/replication/policies/20",
    "DELETE /api/v2.0/replication/policies/20", "GET /api/v2.0/registries/10", "DELETE /api/v2.0/registries/10",
  ])
})

test("a missing policy is recreated and its replacement requires a catch-up", async () => {
  const link = edge()
  stub(prisma.replicationLink, "findUnique", async () => link)
  stub(prisma.replicationLink, "upsert", async () => link)
  stub(prisma.replicationLink, "update", async ({ data }: { data: object }) => Object.assign(link, data))
  stub(prisma.replicationCleanup, "findFirst", async () => null)
  stub(prisma.registry, "findUnique", async () => registry)
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith("/registries/10") && !init?.method) return Response.json({ name: "tessark-peer-b" })
    if (String(input).endsWith("/policies/20")) return new Response(null, { status: 404 })
    if (String(input).endsWith("/policies") && init?.method === "POST") return new Response(null, { status: 201, headers: { location: "/policies/21" } })
    return new Response(null, { status: 200 })
  })
  await applyReplicationLink(source, dest, { type: "event_based" }, { force: true })
  assert.equal(link.harborPolicyId, 21)
  assert.equal(link.status, "ACTIVE")
  assert.equal(link.catchUpRequested, true)
})

test("adopting an existing endpoint updates its stale credentials", async () => {
  let body: Record<string, unknown> | undefined
  mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (String(_input).endsWith("/registries/10") && !init?.method) return Response.json({ name: "peer" })
    if (init?.method === "POST") return new Response(null, { status: 409 })
    if (init?.method === "PUT") { body = JSON.parse(String(init.body)); return new Response(null, { status: 200 }) }
    return Response.json([{ id: 10, name: "peer" }])
  })
  const id = await createHarborRegistryEndpoint(conn, { name: "peer", url: dest.conn.baseUrl, username: "new", secret: "rotated", insecure: false })
  assert.equal(id, 10)
  assert.deepEqual(body?.credential, { type: "basic", access_key: "new", access_secret: "rotated" })
})

test("dispatch without an execution ID is never reported as a successful copy", async () => {
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 201 }))
  await assert.rejects(triggerHarborReplication(conn, 20), /outcome is unknown/)
})

test("the database lock is reentrant and a competing owner cannot run writes", async () => {
  let acquired = true
  const transaction = stub(prisma, "$transaction", async (run: (tx: unknown) => Promise<unknown>) => run({ $queryRaw: async () => [{ acquired }] }))
  let writes = 0
  await withReplicationLock(() => withReplicationLock(async () => { writes++ }))
  assert.equal(transaction.mock.callCount(), 1)
  acquired = false
  await assert.rejects(withReplicationLock(async () => { writes++ }), /already running/)
  assert.equal(writes, 1)
})

test("retry delays are bounded and unknown execution states never imply success", () => {
  assert.equal(retryAt(0, 0).getTime(), 30_000)
  assert.equal(retryAt(1, 0).getTime(), 60_000)
  assert.equal(retryAt(99, 0).getTime(), 3_600_000)
  assert.equal(executionOutcome("Succeed", 1), "failed")
  assert.equal(executionOutcome("Pending"), "running")
  assert.equal(executionOutcome("Unknown"), "running")
})


test("REPLICATION_SYNC is not dequeued when any edge still fails", async () => {
  const op = { id: "op", registryId: "a", kind: "REPLICATION_SYNC", attempts: 0, lastAttemptAt: null }
  stub(prisma, "$transaction", async (run: (tx: unknown) => Promise<unknown>) => run({ $queryRaw: async () => [{ acquired: true }] }))
  stub(prisma.registry, "findUnique", async () => registry)
  stub(prisma.registry, "findMany", async () => [registry, { ...registry, id: "b", name: "B", baseUrl: dest.conn.baseUrl }])
  stub(prisma.cluster, "findUnique", async () => ({ id: "cluster", replicationMode: "event_based", replicationCron: null }))
  stub(prisma.pendingOperation, "count", async () => 1)
  stub(prisma.pendingOperation, "findMany", async () => [op])
  stub(prisma.pendingOperation, "findFirst", async () => op)
  const update = stub(prisma.pendingOperation, "update", async () => op)
  const remove = stub(prisma.pendingOperation, "delete", async () => op)
  stub(prisma.robotPlacement, "count", async () => 0)
  stub(prisma.robotPlacement, "findMany", async () => [])
  stub(prisma.replicationLink, "findMany", async () => [])
  stub(prisma.replicationLink, "findUnique", async () => null)
  stub(prisma.replicationLink, "upsert", async () => edge())
  stub(prisma.replicationCleanup, "findFirst", async () => null)
  mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input)
    if (url.endsWith("/ping")) return new Response("Pong")
    if (url.endsWith("/v2/")) return Response.json({})
    if (url.endsWith("/systeminfo")) return Response.json({ harbor_version: "v2.15.0" })
    return new Response(null, { status: 503 })
  })
  const result = await reconcileRegistry("a")
  assert.equal(result.replayed, 0)
  assert.equal(result.remaining, 1)
  assert.match(result.error!, /replication links still failing/)
  assert.equal(remove.mock.callCount(), 0)
  assert.ok(update.mock.callCount() > 0)
})


test("a reused Harbor policy ID cannot overwrite another owner's policy", async () => {
  const http = mock.method(globalThis, "fetch", async () => Response.json({ id: 20, name: "administrator-policy" }))
  await assert.rejects(updateHarborReplicationPolicy(conn, 20, "tessark-replicate-b", 10, { type: "event_based" }), /no longer belongs/)
  assert.equal(http.mock.callCount(), 1)
  assert.notEqual(http.mock.calls[0].arguments[1]?.method, "PUT")
})
