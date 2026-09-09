/**
 * Runs a conformance campaign against one Harbor and records what happened.
 *
 * This is the only writer of docs/harbor-conformance.json (plan §2). Its discipline is the whole
 * value of the matrix:
 *
 *  - the version recorded is the one read **on the instance**, never the one someone meant to
 *    test;
 *  - a required test with no scenario is recorded as skipped, so its capability stays
 *    inconclusive instead of quietly reading as verified on a partial suite;
 *  - an environment that would not come up is inconclusive, never broken — blaming Harbor for our
 *    own setup is how a matrix loses its readers;
 *  - every capability's proof is tied to the digest of the files behind it, so a later commit in
 *    those files retires the proof by itself.
 *
 * Run with: npm run test:harbor
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  createHarborProject,
  deleteHarborProject,
  deleteHarborRegistryEndpoint,
  deleteHarborReplicationPolicy,
  deleteHarborRepository,
  deleteHarborRobotAccount,
  getHarborVersion,
  harborPing,
  listHarborRepositories,
} from "../../src/lib/registries/harbor"
import {
  HARBOR_CAPABILITIES,
  type ConformanceRun,
  type TestResult,
} from "../../src/lib/registries/harbor-capabilities"
import { surfaceDigests } from "../../tools/harbor-surface"
import {
  SCENARIOS,
  ScenarioUnavailable,
  leftoverReplication,
  leftoverRobots,
  type ScenarioContext,
} from "./scenarios"
import { resolveTarget } from "./target"

const ROOT = resolve(new URL("../..", import.meta.url).pathname)
const CONFORMANCE_PATH = resolve(ROOT, "docs/harbor-conformance.json")

/** Identifies the Gateway code under test. Falls back gracefully: this repo has no git yet. */
function gatewayCommit(): string {
  /* eslint-disable-next-line no-restricted-syntax -- harness, not application code */
  const declared = process.env.GATEWAY_COMMIT
  if (declared) return declared
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return "unversioned"
  }
}

/** Identifies the suite itself, so a rewritten scenario does not inherit an old result. */
function suiteRevision(): string {
  const hash = createHash("sha256")
  for (const file of ["tests/harbor/scenarios.ts", "tests/harbor/run.ts"]) {
    hash.update(readFileSync(resolve(ROOT, file)))
  }
  return hash.digest("hex").slice(0, 12)
}

async function main(): Promise<number> {
  const target = resolveTarget()
  if (!target) {
    console.log(
      "No conformance target configured — nothing ran and nothing was recorded.\n" +
        "  HARBOR_CONFORMANCE_URL=http://harbor.example HARBOR_CONFORMANCE_USERNAME=admin \\\n" +
        "  HARBOR_CONFORMANCE_PASSWORD=… npm run test:harbor",
    )
    return 0
  }

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const finishedAt = new Date().toISOString()
  const digests = surfaceDigests(ROOT)
  const commit = gatewayCommit()
  const revision = suiteRevision()

  if (!(await harborPing(target.conn))) {
    console.error(`${target.label} did not answer /api/v2.0/ping — nothing was measured.`)
    return 1
  }

  const version = await getHarborVersion(target.conn)
  if (!version) {
    // Without an authenticated version read there is nothing to attach a proof to: an anonymous
    // /systeminfo omits harbor_version, so this is almost always a credentials problem.
    console.error(`${target.label} answered ping but no harbor_version — check the credentials.`)
    return 1
  }
  console.log(`Target ${target.label} reports Harbor ${version}; Gateway ${commit}, suite ${revision}.`)

  const scratchProjectName = `tessark-conf-${Math.random().toString(16).slice(2, 10)}`
  let scratchProjectId: number
  try {
    scratchProjectId = await createHarborProject(target.conn, scratchProjectName, { public: false })
  } catch (error) {
    console.error(`Could not create the scratch project on ${target.label}: ${String(error)}`)
    return 1
  }

  const context: ScenarioContext = { conn: target.conn, scratchProjectName, scratchProjectId, version }
  const results = new Map<string, { result: TestResult; symptom?: string }>()

  try {
    for (const scenario of SCENARIOS) {
      try {
        await scenario.run(context)
        results.set(scenario.id, { result: "pass" })
        console.log(`  pass     ${scenario.id}`)
      } catch (error) {
        const unavailable = error instanceof ScenarioUnavailable
        const symptom = error instanceof Error ? error.message : String(error)
        results.set(scenario.id, { result: unavailable ? "skipped" : "fail", symptom })
        console.log(`  ${unavailable ? "skip" : "FAIL"}     ${scenario.id} — ${symptom}`)
      }
    }
  } finally {
    // Teardown in the order Harbor requires, which is the order the scenarios themselves assert:
    // a policy before the endpoint it references, and every artifact before the project holding
    // it. Each step is attempted even if an earlier one failed — a campaign that half-cleans is
    // worse than one that says what it left behind.
    if (leftoverReplication.policyId !== null) {
      await deleteHarborReplicationPolicy(target.conn, leftoverReplication.policyId).catch(() => undefined)
    }
    if (leftoverReplication.endpointId !== null) {
      await deleteHarborRegistryEndpoint(target.conn, leftoverReplication.endpointId).catch(() => undefined)
    }
    for (const [, robotId] of leftoverRobots()) {
      await deleteHarborRobotAccount(target.conn, robotId).catch(() => undefined)
    }
    for (const repository of await listHarborRepositories(target.conn, scratchProjectName).catch(() => [])) {
      await deleteHarborRepository(target.conn, scratchProjectName, repository.name).catch(() => undefined)
    }
    await deleteHarborProject(target.conn, scratchProjectId).catch((error: unknown) => {
      console.error(`Scratch project ${scratchProjectName} could not be removed: ${String(error)}`)
    })
  }

  const runs: ConformanceRun[] = HARBOR_CAPABILITIES.map((capability) => ({
    capabilityId: capability.id,
    harborVersion: version,
    gatewayCommit: commit,
    surfaceDigest: digests[capability.id],
    suiteRevision: revision,
    // Every required test appears, including the ones no scenario covers yet: a silent absence
    // and a recorded skip look the same in a summary, and only one of them is honest.
    tests: capability.requiredTests.map((id) => ({
      id,
      result: results.get(id)?.result ?? "skipped",
      ...(results.get(id)?.symptom ? { symptom: results.get(id)!.symptom } : {}),
    })),
    runId,
    finishedAt,
    context: { target: target.label, authMode: target.conn.authType },
  }))

  const existing = JSON.parse(readFileSync(CONFORMANCE_PATH, "utf8")) as { _note: string; runs: ConformanceRun[] }
  writeFileSync(
    CONFORMANCE_PATH,
    JSON.stringify({ _note: existing._note, runs: [...existing.runs, ...runs] }, null, 2) + "\n",
  )

  const failures = [...results.values()].filter((entry) => entry.result === "fail").length
  const skipped = [...results.values()].filter((entry) => entry.result === "skipped").length
  console.log(
    `\n${results.size - failures - skipped} passed, ${failures} failed, ${skipped} skipped; ` +
      `${runs.length} capability results recorded for Harbor ${version}.`,
  )
  console.log("Run `npm run gen:harbor-matrix` to fold this into the published matrix.")
  return failures > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
