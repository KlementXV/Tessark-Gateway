import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"

import { prisma } from "../src/lib/prisma"
import {
  HARBOR_VERSION_FRESH_MS,
  readHarborObservation,
  recordHarborObservation,
} from "../src/lib/registries/version-cache"
import { assessHarborVersion, degradedCapabilities, minorSpread } from "../src/lib/registries/compatibility"
import type { RegistryHealth } from "../src/lib/registries/health"

const restore: Array<() => void> = []
function stub(target: object, name: string, implementation: (...args: never[]) => unknown) {
  const obj = target as Record<string, unknown>
  const original = obj[name]
  obj[name] = mock.fn(implementation)
  restore.push(() => {
    obj[name] = original
  })
}
afterEach(() => {
  while (restore.length) restore.pop()!()
})

const healthy: RegistryHealth = { reachable: true, harbor: true, authenticated: true, version: "v2.15.0" }
const unreachable: RegistryHealth = { reachable: false, harbor: false, authenticated: false, version: null }

function captureWrites() {
  const writes: Array<{ where: unknown; data: unknown }> = []
  stub(prisma.registry, "updateMany", async (args: { where: unknown; data: unknown }) => {
    writes.push(args)
    return { count: 1 }
  })
  return writes
}

// --- what may be written ----------------------------------------------------------------------

test("a probe of an unsaved connection never writes", async () => {
  // POST /api/registries/check builds a connection with an empty id from an edited form. A probe
  // must stay a probe: writing here would attach a reading to whatever row happened to be next.
  const writes = captureWrites()
  await recordHarborObservation({ id: "", baseUrl: "https://harbor.example" }, healthy)
  assert.deepEqual(writes, [])
})

test("a failed probe keeps what was known instead of erasing it", async () => {
  const writes = captureWrites()
  await recordHarborObservation({ id: "reg1", baseUrl: "https://harbor.example" }, unreachable)
  await recordHarborObservation(
    { id: "reg1", baseUrl: "https://harbor.example" },
    { reachable: true, harbor: true, authenticated: false, version: null },
  )
  assert.deepEqual(writes, [], "no version was read, so there is nothing to record")
})

test("a reading is written only for the target the row still points at", async () => {
  const writes = captureWrites()
  await recordHarborObservation({ id: "reg1", baseUrl: "https://harbor.example" }, healthy, new Date("2026-09-09T10:00:00Z"))
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].where, { id: "reg1", baseUrl: "https://harbor.example" })
  assert.deepEqual(writes[0].data, {
    harborVersion: "v2.15.0",
    harborVersionSeenAt: new Date("2026-09-09T10:00:00Z"),
  })
})

// --- how it is read ---------------------------------------------------------------------------

test("an observation carries its age, and a stale one is still an observation", () => {
  const now = new Date("2026-09-09T12:00:00Z")
  const recent = new Date(now.getTime() - HARBOR_VERSION_FRESH_MS / 2)
  const old = new Date(now.getTime() - HARBOR_VERSION_FRESH_MS * 3)

  assert.equal(readHarborObservation({ harborVersion: "2.15.0", harborVersionSeenAt: recent }, now).fresh, true)

  const stale = readHarborObservation({ harborVersion: "2.15.0", harborVersionSeenAt: old }, now)
  assert.equal(stale.fresh, false)
  assert.equal(stale.version, "2.15.0", "an aged reading is shown dated, never blanked")

  assert.equal(readHarborObservation({ harborVersion: null, harborVersionSeenAt: null }, now).fresh, false)
})

// --- what the fleet shows ---------------------------------------------------------------------

test("a cluster whose members run different minors is reported as such", () => {
  assert.deepEqual(minorSpread(["v2.15.0", "2.15.2"]), { minors: ["2.15"], unknown: 0 })
  assert.deepEqual(minorSpread(["v2.15.0", "v2.11.1"]), { minors: ["2.11", "2.15"], unknown: 0 })
  // Silence is not divergence: a member we could not read is counted apart, never folded into
  // agreement between the others.
  assert.deepEqual(minorSpread(["v2.15.0", null]), { minors: ["2.15"], unknown: 1 })
})

test("an unreadable version concludes nothing, in either direction", () => {
  const assessment = assessHarborVersion(null)
  assert.equal(assessment.support, "unknown")
  assert.ok(assessment.capabilities.every((capability) => capability.availability === "unknown"))
  assert.ok(assessment.capabilities.every((capability) => capability.proof === "unknown"))
})

test("the product reads the same evidence the published matrix does", () => {
  const assessment = assessHarborVersion("v2.15.0", new Date("2026-09-09T00:00:00Z"))
  const identity = assessment.capabilities.find((capability) => capability.capabilityId === "harbor-identity")!
  assert.equal(identity.availability, "available")
  assert.equal(identity.proof, "verified", "the recorded campaign should reach the product, not just the doc")

  // A Harbor too old for a capability lists it as degraded, with its i18n key ready to explain.
  const old = assessHarborVersion("v2.10.0")
  const degraded = degradedCapabilities(old).map((capability) => capability.capabilityId)
  assert.ok(degraded.includes("sbom-generation"))
  assert.equal(degradedCapabilities(old)[0].availability, "unavailable", "unavailable comes first")
})
