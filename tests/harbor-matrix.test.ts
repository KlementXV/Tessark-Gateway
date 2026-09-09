import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { HARBOR_CAPABILITIES, HARBOR_SUPPORT_POLICY } from "../src/lib/registries/harbor-capabilities"
import { MATRIX_PATH, render } from "../scripts/gen-harbor-matrix"
import { collectOperations, digestFiles, normalizePath, reconcileSurface } from "../tools/harbor-surface"

const ROOT = new URL("..", import.meta.url).pathname

test("every Harbor call the code makes is answered for by a capability", () => {
  const { unclaimed, phantom } = reconcileSurface(ROOT)
  // A new call with no capability behind it would ship a function the matrix cannot describe;
  // a capability naming an operation nobody issues describes code that is gone.
  assert.deepEqual(unclaimed, [], `unclaimed Harbor operations: ${unclaimed.join(", ")}`)
  assert.deepEqual(phantom, [], `capabilities declaring dead operations: ${JSON.stringify(phantom)}`)
})

test("the surface is read from calls, not from prose that mentions a path", () => {
  // check.ts quotes "/api/v2.0/ping" inside the message shown when a registry is not a Harbor.
  assert.equal(normalizePath("/api/v2.0/ping did not answer."), null)
  assert.equal(normalizePath("/api/v2.0/projects/{}/members"), "/projects/{}/members")
  assert.equal(normalizePath("/api/v2.0/projects?page_size=100"), "/projects")
  assert.equal(normalizePath("/api/v2.0/"), "/")
})

test("the method is taken from the request, not guessed from the path", () => {
  const operations = collectOperations(ROOT)
  const methodsForProjects = operations.filter((o) => o.path === "/projects").map((o) => o.method).sort()
  assert.deepEqual(methodsForProjects, ["GET", "POST"])
  assert.ok(operations.some((o) => o.method === "PATCH" && o.path === "/robots/{}"))
})

test("a capability's digest follows the files behind it", () => {
  const stable = digestFiles(ROOT, ["package.json"])
  assert.equal(digestFiles(ROOT, ["package.json"]), stable)
  assert.notEqual(digestFiles(ROOT, ["package.json", "tsconfig.json"]), stable)
  // Order must not matter: the file set is what identifies the code, not how it was collected.
  assert.equal(
    digestFiles(ROOT, ["package.json", "tsconfig.json"]),
    digestFiles(ROOT, ["tsconfig.json", "package.json"]),
  )
})

test("the generated matrix is deterministic and committed in sync", () => {
  // Determinism is what lets `--check` be a build gate: the generator never reads the clock, so
  // the file only changes when the catalogue or the recorded evidence changes.
  assert.equal(render(), render())
  assert.equal(
    render(),
    readFileSync(MATRIX_PATH, "utf8"),
    "docs/harbor/README.md is stale — run `npm run gen:harbor-matrix`.",
  )
})

test("every ✓ in the matrix is backed by a run that passed every required test", () => {
  const matrix = readFileSync(MATRIX_PATH, "utf8")
  const conformance = JSON.parse(readFileSync(new URL("../docs/harbor-conformance.json", import.meta.url), "utf8"))
  const runs = conformance.runs as Array<{
    capabilityId: string
    tests: Array<{ id: string; result: string }>
  }>

  // Only the table cells, not the legend that explains what a ✓ means.
  const rows = matrix.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Capacité"))
  assert.ok(rows.length > 0, "the matrix has no rows")

  for (const row of rows) {
    if (!row.includes("✓")) continue
    const id = row.split("|")[1].trim()
    const capability = HARBOR_CAPABILITIES.find((entry) => entry.id === id)!
    const backed = runs.some(
      (run) =>
        run.capabilityId === id &&
        capability.requiredTests.every((test) =>
          run.tests.some((entry) => entry.id === test && entry.result === "pass"),
        ),
    )
    assert.ok(backed, `${id} reads verified but no recorded run passes all of its required tests`)
  }
})

test("the declared support window never claims more than the evidence", () => {
  const conformance = JSON.parse(readFileSync(new URL("../docs/harbor-conformance.json", import.meta.url), "utf8"))
  const measured = new Set((conformance.runs as Array<{ harborVersion: string }>).map((run) => run.harborVersion))
  for (const declared of HARBOR_SUPPORT_POLICY.verifiedVersions) {
    assert.ok(
      [...measured].some((version) => version.startsWith(declared) || version.startsWith(`v${declared}`)),
      `${declared} is declared as covered by a campaign, but no run records it`,
    )
  }
})
