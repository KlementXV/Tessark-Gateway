import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SpecReader,
  compareOperation,
  compareSpecs,
  normalizeSpecPath,
  specPathCount,
} from "../tools/harbor-spec-diff"

const ARTIFACT_LIST = "GET /projects/{}/repositories/{}/artifacts"

function reader(paths: Record<string, unknown>, definitions: Record<string, unknown> = {}) {
  return new SpecReader({ paths, definitions })
}

/** A GET whose 200 response carries `schema`, and whose query takes `parameters`. */
function operation(schema: unknown, parameters: unknown[] = []) {
  return { "/thing": { get: { parameters, responses: { "200": { schema } } } } }
}

test("spec paths and code paths are compared in the same shape", () => {
  assert.equal(normalizeSpecPath("/projects/{project_name}/members/{mid}"), "/projects/{}/members/{}")
  assert.equal(normalizeSpecPath("/ping"), "/ping")
})

// --- against the pinned upstream specs ---------------------------------------------------------

test("the SBOM surface arrives in 2.11, which is the version the code refuses it on", () => {
  const sbom = compareSpecs("2.10.0", "2.11.0").find((entry) => entry.capabilityId === "sbom-generation")!
  assert.deepEqual(sbom.breakingChanges, [])
  assert.ok(
    sbom.additions.some((line) => line.includes("PUT /projects/{}") && line.includes("auto_sbom_generation")),
    "auto_sbom_generation should show as an addition between 2.10.0 and 2.11.0",
  )
  // The catalogue's disputed bound rests on this: upstream declared the field a minor earlier
  // than harborSupportsSbom() allows it. Only a conformance run can settle who is right.
  assert.ok(sbom.additions.some((line) => line.includes("with_sbom_overview")))
})

test("the same field produces nothing between 2.11 and 2.15, where it is unchanged", () => {
  const comparisons = compareSpecs("2.11.0", "2.15.0")
  const mentions = comparisons.flatMap((entry) => [...entry.breakingChanges, ...entry.additions])
  assert.equal(
    mentions.filter((line) => line.includes("auto_sbom_generation")).length,
    0,
    "2.11 -> 2.15 must not report a field that is identical on both sides",
  )
})

test("a query parameter the Gateway still sends, dropped upstream, reads as breaking", () => {
  // Measured 2026-09-08: 2.15.0 removed with_signature from the artifact *list* operation while
  // keeping it on the single artifact. harbor.ts sends one shared constant to both.
  const catalogue = compareSpecs("2.11.0", "2.15.0").find((entry) => entry.capabilityId === "catalog-browse")!
  assert.ok(
    catalogue.breakingChanges.some(
      (line) => line.startsWith(ARTIFACT_LIST) && line.includes("with_signature") && line.includes("removed"),
    ),
    `expected the with_signature removal, got: ${catalogue.breakingChanges.join(" | ")}`,
  )
})

test("a spec that does not parse can never read as 'nothing changed'", () => {
  // 2.10.0 and 2.11.0 mis-quote one description and fail a strict YAML parse. The comparison is
  // still useful, but it is marked incomplete, which stops evaluateCapability() from ever
  // turning it into `expected`.
  for (const entry of compareSpecs("2.10.0", "2.11.0")) {
    assert.equal(entry.complete, false)
    assert.ok(entry.incompleteReasons.some((reason) => reason.includes("does not parse")))
  }
  assert.ok(specPathCount("2.15.0") > 100)
})

// --- synthetic contracts, for the rules themselves ---------------------------------------------

test("a parameter that becomes required breaks callers that never sent it", () => {
  const before = reader(operation({ type: "object" }, [{ name: "scope", type: "string" }]))
  const after = reader(operation({ type: "object" }, [{ name: "scope", type: "string", required: true }]))
  const { changes } = compareOperation(before, after, "GET /thing")
  assert.deepEqual(
    changes.map((change) => `${change.kind}:${change.location}:${change.detail}`),
    ["breaking:parameters.scope:became required"],
  )
})

test("a response field removed behind a $ref is found, not hidden by the indirection", () => {
  const definitions = {
    Thing: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } },
  }
  const before = reader(operation({ $ref: "#/definitions/Thing" }), definitions)
  const after = reader(operation({ $ref: "#/definitions/Thing" }), {
    Thing: { type: "object", properties: { id: { type: "string" } } },
  })
  const { changes } = compareOperation(before, after, "GET /thing")
  assert.deepEqual(changes.map((change) => change.location), ["response.200.label"])
  assert.equal(changes[0].kind, "breaking")
})

test("a recursive definition terminates instead of walking forever", () => {
  const definitions = {
    Node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/definitions/Node" } } },
  }
  const spec = reader(operation({ $ref: "#/definitions/Node" }), definitions)
  const { changes, incompleteReasons } = compareOperation(spec, spec, "GET /thing")
  assert.deepEqual(changes, [])
  // A cycle is a fully known shape, not a gap: it must not make the comparison incomplete.
  assert.deepEqual(incompleteReasons, [])
})

test("a $ref that goes nowhere makes the comparison incomplete", () => {
  const spec = reader(operation({ $ref: "#/definitions/Missing" }))
  const { incompleteReasons } = compareOperation(spec, spec, "GET /thing")
  assert.equal(incompleteReasons.length, 2, "both sides should report the unresolved reference")
  assert.ok(incompleteReasons[0].includes("unresolved #/definitions/Missing"))
})

test("an enum change is read in the direction it hurts", () => {
  const withValues = (values: string[]) =>
    reader(operation({ type: "object", properties: { state: { type: "string", enum: values } } }))
  const request = (values: string[]) =>
    reader(operation({ type: "object" }, [{ name: "state", type: "string", enum: values }]))

  // A response gaining a value surprises a consumer that switches exhaustively.
  assert.equal(compareOperation(withValues(["a"]), withValues(["a", "b"]), "GET /thing").changes[0].kind, "breaking")
  // A request gaining one accepts more than before: nothing a caller sent stops working.
  assert.equal(compareOperation(request(["a"]), request(["a", "b"]), "GET /thing").changes[0].kind, "addition")
  // A request losing one rejects calls that used to work.
  assert.equal(compareOperation(request(["a", "b"]), request(["a"]), "GET /thing").changes[0].kind, "breaking")
})

test("an operation that disappears upstream is the loudest signal available", () => {
  const before = reader(operation({ type: "object" }))
  const { changes } = compareOperation(before, reader({}), "GET /thing")
  assert.deepEqual(changes, [
    { kind: "breaking", operation: "GET /thing", location: "operation", detail: "removed upstream" },
  ])
})
