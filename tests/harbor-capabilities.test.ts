import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { harborSupportsSbom } from "../src/lib/registries/harbor"
import {
  HARBOR_CAPABILITIES,
  capabilityAvailability,
  capabilityById,
  evaluateCapability,
  isProofStale,
  outcomeOf,
  parseHarborVersion,
  versionMatches,
  type ConformanceRun,
  type HarborCapability,
} from "../src/lib/registries/harbor-capabilities"

const sbom = capabilityById("sbom-generation")!
const parse = (raw: string) => parseHarborVersion(raw)!

// --- versions -------------------------------------------------------------------------------

test("a Harbor version is read from what /systeminfo actually returns", () => {
  assert.deepEqual(parseHarborVersion("v2.15.2"), { major: 2, minor: 15, patch: 2 })
  assert.deepEqual(parseHarborVersion("2.15"), { major: 2, minor: 15, patch: 0 })
  // A release candidate is that release for our purposes: refusing to read it would silently
  // disable functions on a test instance, which is where rc builds live.
  assert.deepEqual(parseHarborVersion("v2.16.0-rc1"), { major: 2, minor: 16, patch: 0 })
})

test("an unreadable version is null, never an old one", () => {
  for (const raw of [null, undefined, "", "dev", "unknown", "harbor v2.15"]) {
    assert.equal(parseHarborVersion(raw), null, `${String(raw)} should not parse`)
  }
})

test("a bare minor bound covers its patches, a full version does not", () => {
  assert.equal(versionMatches(parse("2.14.7"), "2.14"), true)
  assert.equal(versionMatches(parse("2.15.0"), "2.14"), false)
  assert.equal(versionMatches(parse("2.14.7"), "2.14.1"), false)
  assert.equal(versionMatches(parse("2.14.1"), "2.14.1"), true)
  assert.equal(versionMatches(parse("2.12.0"), ">=2.12"), true)
  assert.equal(versionMatches(parse("2.11.9"), ">=2.12"), false)
  assert.equal(versionMatches(parse("2.11.9"), "<2.12"), true)
  assert.throws(() => versionMatches(parse("2.15.0"), "2.x"), /Unparsable/)
})

// --- availability ---------------------------------------------------------------------------

test("the SBOM bound is applied conservatively while it is disputed", () => {
  assert.equal(sbom.sinceConfidence, "disputed")
  assert.equal(capabilityAvailability(sbom, parse("2.11.9")), "unavailable")
  assert.equal(capabilityAvailability(sbom, parse("2.12.0")), "available")
  assert.equal(capabilityAvailability(sbom, parse("3.0.0")), "available")
})

test("an unreadable version yields unknown availability, not unavailable", () => {
  assert.equal(capabilityAvailability(sbom, null), "unknown")
})

test("an exception outranks the general bound, in both directions", () => {
  const base: HarborCapability = { ...sbom, exceptions: [{ range: "2.14.1", available: false, reasonKey: "x" }] }
  assert.equal(capabilityAvailability(base, parse("2.14.1")), "unavailable")
  assert.equal(capabilityAvailability(base, parse("2.14.2")), "available")

  const early: HarborCapability = { ...sbom, exceptions: [{ range: "2.11", available: true, reasonKey: "x" }] }
  assert.equal(capabilityAvailability(early, parse("2.11.3")), "available")
})

test("a removed capability stops being available at its removal", () => {
  const removed: HarborCapability = { ...sbom, since: "2.0", removedIn: "2.11" }
  assert.equal(capabilityAvailability(removed, parse("2.10.9")), "available")
  assert.equal(capabilityAvailability(removed, parse("2.11.0")), "unavailable")
})

test("harborSupportsSbom keeps its contract now that the catalogue answers for it", () => {
  // The call sites treat false as "leave the key out", so anything unreadable must answer false:
  // sending auto_sbom_generation to a Harbor that validates metadata keys costs the whole PUT.
  for (const version of [null, "", "dev", "2.11", "v2.11.9"]) assert.equal(harborSupportsSbom(version), false)
  for (const version of ["2.12", "v2.12.0", "v2.15.2", "3.0.0"]) assert.equal(harborSupportsSbom(version), true)
})

// --- proof ----------------------------------------------------------------------------------

const DIGEST = "abc123"
const digests = { "sbom-generation": DIGEST }

function run(overrides: Partial<ConformanceRun> = {}): ConformanceRun {
  return {
    capabilityId: "sbom-generation",
    harborVersion: "2.15.2",
    gatewayCommit: "deadbeef",
    surfaceDigest: DIGEST,
    suiteRevision: "1",
    tests: sbom.requiredTests.map((id) => ({ id, result: "pass" as const })),
    runId: "run-1",
    finishedAt: "2026-09-01T00:00:00.000Z",
    context: {},
    ...overrides,
  }
}

const evaluate = (runs: ConformanceRun[], extra: Partial<Parameters<typeof evaluateCapability>[0]> = {}) =>
  evaluateCapability({
    capability: sbom,
    version: parse("2.15.2"),
    runs,
    surfaceDigests: digests,
    now: new Date("2026-09-08T00:00:00.000Z"),
    ...extra,
  })

test("a capability nobody ran is unknown, not supported and not broken", () => {
  const assessment = evaluate([])
  assert.equal(assessment.proof, "unknown")
  assert.equal(assessment.reasonKey, "never-run")
})

test("a run proves the exact version it ran on, and no other", () => {
  assert.equal(evaluate([run()]).proof, "verified")
  assert.equal(evaluate([run({ harborVersion: "2.15.1" })]).proof, "unknown")
})

test("a required test that was skipped never yields verified", () => {
  const partial = run({ tests: [{ id: sbom.requiredTests[0], result: "pass" }] })
  assert.equal(outcomeOf(partial, sbom), "inconclusive")
  assert.equal(evaluate([partial]).proof, "inconclusive")
})

test("a functional failure outranks everything that follows it", () => {
  const failed = run({
    runId: "run-fail",
    finishedAt: "2026-09-02T00:00:00.000Z",
    tests: sbom.requiredTests.map((id, index) => ({ id, result: index === 1 ? ("fail" as const) : ("pass" as const) })),
  })
  const assessment = evaluate([run(), failed])
  assert.equal(assessment.proof, "broken")
  assert.equal(assessment.provenBy?.runId, "run-fail")
})

test("an inconclusive attempt does not erase the last real pass, and does not pass for one", () => {
  // The environment failed to come up after a genuine pass. Blaming Harbor for our own CI is how
  // a matrix loses its readers, so the pass stands — flagged, not overwritten.
  const flaky = run({
    runId: "run-flaky",
    finishedAt: "2026-09-03T00:00:00.000Z",
    tests: sbom.requiredTests.map((id) => ({ id, result: "skipped" as const })),
  })
  const assessment = evaluate([run(), flaky])
  assert.equal(assessment.proof, "verified")
  assert.equal(assessment.provenBy?.runId, "run-1")
  assert.equal(assessment.lastRunInconclusive, true)

  // On its own, the same attempt certifies nothing.
  assert.equal(evaluate([flaky]).proof, "inconclusive")
})

test("a failure that a later run turns into a pass stops standing", () => {
  // The rule is per test, not per run: a capability must not stay marked broken by a defect that
  // no longer reproduces — otherwise the first bad campaign condemns it until a *complete* run
  // happens to certify the whole capability at once.
  const failed = run({
    runId: "run-fail",
    finishedAt: "2026-09-02T00:00:00.000Z",
    tests: sbom.requiredTests.map((id, index) => ({ id, result: index === 0 ? ("fail" as const) : ("pass" as const) })),
  })
  const fixed = run({
    runId: "run-fixed",
    finishedAt: "2026-09-03T00:00:00.000Z",
    tests: [{ id: sbom.requiredTests[0], result: "pass" as const }],
  })
  assert.equal(evaluate([failed]).proof, "broken")
  assert.equal(evaluate([failed, fixed]).proof, "verified")

  // A later run that merely skips the failing test brings no news, so the failure still stands.
  const silent = run({
    runId: "run-silent",
    finishedAt: "2026-09-04T00:00:00.000Z",
    tests: [{ id: sbom.requiredTests[0], result: "skipped" as const }],
  })
  assert.equal(evaluate([failed, silent]).proof, "broken")
})

test("a proof dies with the code it described", () => {
  // The same run, once the files behind the capability have changed: it described code that is
  // no longer there, so it cannot keep certifying the capability.
  assert.equal(evaluate([run({ surfaceDigest: "other" })]).proof, "unknown")
})

test("expected needs a complete comparison against a verified reference", () => {
  const reference = run({ harborVersion: "2.15.0" })
  const evidence = [
    { capabilityId: "sbom-generation", fromVersion: "2.15.0", toVersion: "2.15.2", complete: true, breakingChanges: [] },
  ]
  assert.equal(evaluate([reference], { specEvidence: evidence }).proof, "expected")

  // Same diff, but nothing verified the reference: nothing to extend.
  assert.equal(evaluate([], { specEvidence: evidence }).proof, "unknown")

  // Same reference, but a $ref could not be resolved: an incomplete comparison proves nothing.
  const incomplete = [{ ...evidence[0], complete: false }]
  assert.equal(evaluate([reference], { specEvidence: incomplete }).proof, "unknown")
})

test("a proof ages, and says so without ceasing to be a proof", () => {
  const fresh = run({ finishedAt: "2026-09-01T00:00:00.000Z" })
  assert.equal(isProofStale(fresh, new Date("2026-09-08T00:00:00.000Z")), false)
  assert.equal(isProofStale(fresh, new Date("2027-06-01T00:00:00.000Z")), true)
  // A newer Harbor minor than the one that was proven also ages it, however recent the run.
  assert.equal(isProofStale(run({ harborVersion: "2.14.4" }), new Date("2026-09-08T00:00:00.000Z")), true)
})

// --- catalogue integrity ---------------------------------------------------------------------

test("every capability can actually be proven, and explains its own degradation", () => {
  const en = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))
  const fr = JSON.parse(readFileSync(new URL("../messages/fr.json", import.meta.url), "utf8"))
  const ids = new Set<string>()

  for (const capability of HARBOR_CAPABILITIES) {
    assert.equal(ids.has(capability.id), false, `duplicate capability id ${capability.id}`)
    ids.add(capability.id)
    // A capability with no required test could never leave "unknown" — it would sit in the
    // matrix forever looking like an oversight, which is exactly what it would be.
    assert.ok(capability.requiredTests.length > 0, `${capability.id} declares no required test`)
    assert.ok(capability.operations.length > 0, `${capability.id} declares no operation`)
    assert.ok(capability.availabilityEvidence.length > 0, `${capability.id} states no evidence`)
    for (const catalogue of [en, fr]) {
      assert.ok(catalogue.harborCompatibility.capabilities[capability.nameKey]?.name, `${capability.id}: name`)
      assert.ok(
        catalogue.harborCompatibility.capabilities[capability.degradationKey]?.degradation,
        `${capability.id}: degradation`,
      )
    }
  }
})
