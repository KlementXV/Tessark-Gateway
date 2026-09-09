/**
 * Compares two pinned Harbor Swagger specs, restricted to the operations the Gateway calls.
 *
 * The upstream spec carries 106 paths; the Gateway issues 43 operations across a quarter of them
 * (tools/harbor-surface.ts). A full diff would drown the one line that matters, so the comparison
 * starts from the catalogue's operations and follows their `$ref` closure — parameters, bodies,
 * responses and every shared definition they reach.
 *
 * What this tool is, and is not (plan §3.2): it is an early warning on the *contract*, cheap
 * enough to run on every watch PR. It says nothing about behaviour — whether a PUT actually
 * accepts a metadata key, what SBOM format Trivy emits, whether a policy delete answers 412.
 * Those need the conformance suite, and no clean diff here may ever stand in for one.
 *
 * Run with: npx tsx tools/harbor-spec-diff.ts <fromVersion> <toVersion> [--json]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseDocument } from "yaml"

import { HARBOR_CAPABILITIES } from "../src/lib/registries/harbor-capabilities"

const FIXTURES = resolve(new URL("..", import.meta.url).pathname, "tests/fixtures/harbor-spec")

type Json = Record<string, unknown>

export type ChangeKind = "breaking" | "addition" | "info"

export interface SpecChange {
  kind: ChangeKind
  operation: string
  /** Where in the contract: "parameters.project_name_or_id", "response.200.metadata.auto_scan". */
  location: string
  detail: string
}

export interface CapabilityComparison {
  capabilityId: string
  fromVersion: string
  toVersion: string
  /** False when an operation or a $ref could not be resolved on either side. */
  complete: boolean
  breakingChanges: string[]
  additions: string[]
  info: string[]
  incompleteReasons: string[]
}

/** Collapses a spec path to the shape tools/harbor-surface.ts produces: /projects/{}/members. */
export function normalizeSpecPath(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "") || "/"
}

/**
 * Loads a pinned spec, tolerating what upstream actually ships.
 *
 * The 2.10.0 and 2.11.0 documents are not valid YAML: `reuse_sys_cve_allowlist`'s description is
 * a single-quoted scalar whose continuation line is not indented past its parent, which a strict
 * parser refuses (2.15.0 no longer has it). Refusing to compare those versions because upstream
 * mis-quoted a description would be the tool failing at its one job, so the document is parsed
 * leniently and the errors are carried forward: they make every comparison drawn from it
 * `complete: false`, which is what stops a partial read from ever reading as "nothing changed".
 */
function loadSpec(version: string): { spec: Json; parseErrors: string[] } {
  const document = parseDocument(readFileSync(resolve(FIXTURES, `${version}.yaml`), "utf8"))
  return {
    spec: (document.toJS() ?? {}) as Json,
    parseErrors: document.errors.map((error) => `${version}.yaml does not parse: ${error.message.split("\n")[0]}`),
  }
}

/**
 * A flattened view of one operation's contract.
 *
 * Keys are contract locations, values are the facts we are willing to call a change. Only what
 * a client can break on is kept: presence, requiredness, type, and the accepted value set —
 * descriptions live in `info` and never gate anything.
 */
interface Contract {
  fields: Map<string, { required: boolean; type: string; enum?: string[]; direction: "request" | "response" }>
  unresolved: string[]
}

export class SpecReader {
  constructor(private readonly spec: Json) {}

  operation(method: string, normalizedPath: string): Json | null {
    const paths = (this.spec.paths ?? {}) as Record<string, Json>
    for (const [path, item] of Object.entries(paths)) {
      if (normalizeSpecPath(path) !== normalizedPath) continue
      const operation = (item as Record<string, unknown>)[method.toLowerCase()]
      if (operation) return operation as Json
    }
    return null
  }

  /** Resolves a local `$ref`, or null when it points outside this document. */
  resolve(ref: string): Json | null {
    if (!ref.startsWith("#/")) return null
    let current: unknown = this.spec
    for (const segment of ref.slice(2).split("/")) {
      if (typeof current !== "object" || current === null) return null
      current = (current as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")]
    }
    return (current as Json) ?? null
  }
}

/**
 * Walks a schema into flat fields, following `$ref` with cycle protection.
 *
 * Harbor's own definitions are recursive in places, and a naive walk never returns. A cycle is
 * not an incompleteness — the shape is fully known, we simply stop repeating it — so it is not
 * reported, whereas a `$ref` that cannot be resolved is: an incomplete comparison must never be
 * allowed to read as "no breaking change".
 */
function walkSchema(
  reader: SpecReader,
  schema: Json | null,
  prefix: string,
  direction: "request" | "response",
  contract: Contract,
  seen: Set<string>,
  requiredNames: Set<string> = new Set(),
): void {
  if (!schema) return

  const ref = schema.$ref
  if (typeof ref === "string") {
    if (seen.has(ref)) return
    seen.add(ref)
    const resolved = reader.resolve(ref)
    if (!resolved) {
      contract.unresolved.push(`${prefix}: unresolved ${ref}`)
      return
    }
    walkSchema(reader, resolved, prefix, direction, contract, seen, requiredNames)
    return
  }

  const required = new Set([...(Array.isArray(schema.required) ? (schema.required as string[]) : [])])
  const properties = schema.properties as Record<string, Json> | undefined
  if (properties) {
    for (const [name, property] of Object.entries(properties)) {
      const location = prefix ? `${prefix}.${name}` : name
      const child = property as Json
      contract.fields.set(location, {
        required: required.has(name),
        type: String(child.type ?? (child.$ref ? "ref" : "object")),
        enum: Array.isArray(child.enum) ? (child.enum as unknown[]).map(String).sort() : undefined,
        direction,
      })
      walkSchema(reader, child, location, direction, contract, new Set(seen), required)
    }
  }

  if (schema.items) walkSchema(reader, schema.items as Json, `${prefix}[]`, direction, contract, new Set(seen))
}

function contractOf(reader: SpecReader, method: string, path: string): Contract | null {
  const operation = reader.operation(method, path)
  if (!operation) return null
  const contract: Contract = { fields: new Map(), unresolved: [] }

  for (const raw of (operation.parameters ?? []) as Json[]) {
    const parameter = raw.$ref ? reader.resolve(String(raw.$ref)) : raw
    if (!parameter) {
      contract.unresolved.push(`parameters: unresolved ${String(raw.$ref)}`)
      continue
    }
    const name = String(parameter.name ?? "?")
    const location = `parameters.${name}`
    contract.fields.set(location, {
      required: parameter.required === true,
      type: String(parameter.type ?? "body"),
      enum: Array.isArray(parameter.enum) ? (parameter.enum as unknown[]).map(String).sort() : undefined,
      direction: "request",
    })
    if (parameter.schema) {
      walkSchema(reader, parameter.schema as Json, `body`, "request", contract, new Set())
    }
  }

  for (const [code, raw] of Object.entries((operation.responses ?? {}) as Record<string, Json>)) {
    if (!/^2\d\d$/.test(code)) continue
    const response = raw.$ref ? reader.resolve(String(raw.$ref)) : raw
    if (!response) {
      contract.unresolved.push(`response.${code}: unresolved ${String(raw.$ref)}`)
      continue
    }
    if (response.schema) {
      walkSchema(reader, response.schema as Json, `response.${code}`, "response", contract, new Set())
    }
  }

  return contract
}

/** Compares one operation between two specs. */
export function compareOperation(from: SpecReader, to: SpecReader, operation: string): {
  changes: SpecChange[]
  incompleteReasons: string[]
} {
  const [method, path] = operation.split(" ")
  const before = contractOf(from, method, path)
  const after = contractOf(to, method, path)
  const changes: SpecChange[] = []
  const incompleteReasons: string[] = []

  if (!before) incompleteReasons.push(`${operation}: absent from the source spec`)
  if (!after) {
    // The operation the Gateway calls is gone: that is the loudest thing this tool can say.
    changes.push({ kind: "breaking", operation, location: "operation", detail: "removed upstream" })
    return { changes, incompleteReasons }
  }
  if (!before) return { changes, incompleteReasons }

  incompleteReasons.push(...before.unresolved.map((reason) => `${operation}: ${reason}`))
  incompleteReasons.push(...after.unresolved.map((reason) => `${operation}: ${reason}`))

  for (const [location, field] of before.fields) {
    const now = after.fields.get(location)
    if (!now) {
      changes.push({
        kind: "breaking",
        operation,
        location,
        detail: field.direction === "response" ? "response field removed" : "request field removed",
      })
      continue
    }
    if (now.type !== field.type) {
      changes.push({ kind: "breaking", operation, location, detail: `type ${field.type} -> ${now.type}` })
    }
    if (!field.required && now.required) {
      changes.push({ kind: "breaking", operation, location, detail: "became required" })
    }
    if (field.enum && now.enum) {
      // Direction decides who is hurt: a request loses values a client may still send, while a
      // response gains values a client that switches exhaustively has never seen.
      const removed = field.enum.filter((value) => !now.enum!.includes(value))
      const added = now.enum.filter((value) => !field.enum!.includes(value))
      if (removed.length > 0) {
        changes.push({ kind: "breaking", operation, location, detail: `accepted values removed: ${removed.join(", ")}` })
      }
      if (added.length > 0) {
        changes.push({
          kind: field.direction === "response" ? "breaking" : "addition",
          operation,
          location,
          detail: `values added: ${added.join(", ")}`,
        })
      }
    }
  }

  for (const [location, field] of after.fields) {
    if (before.fields.has(location)) continue
    changes.push({
      kind: field.required ? "breaking" : "addition",
      operation,
      location,
      detail: field.required ? "new required field" : "new optional field",
    })
  }

  return { changes, incompleteReasons }
}

/** The whole catalogue, capability by capability. */
export function compareSpecs(fromVersion: string, toVersion: string): CapabilityComparison[] {
  const source = loadSpec(fromVersion)
  const target = loadSpec(toVersion)
  const from = new SpecReader(source.spec)
  const to = new SpecReader(target.spec)
  const parseErrors = [...source.parseErrors, ...target.parseErrors]

  return HARBOR_CAPABILITIES.map((capability) => {
    const changes: SpecChange[] = []
    const incompleteReasons: string[] = [...parseErrors]
    for (const operation of capability.operations) {
      const result = compareOperation(from, to, operation)
      changes.push(...result.changes)
      incompleteReasons.push(...result.incompleteReasons)
    }
    const describe = (change: SpecChange) => `${change.operation} · ${change.location} · ${change.detail}`
    return {
      capabilityId: capability.id,
      fromVersion,
      toVersion,
      complete: incompleteReasons.length === 0,
      breakingChanges: changes.filter((change) => change.kind === "breaking").map(describe),
      additions: changes.filter((change) => change.kind === "addition").map(describe),
      info: changes.filter((change) => change.kind === "info").map(describe),
      incompleteReasons,
    }
  })
}

/** Distinct paths a spec declares — context for how narrow the comparison is. */
export function specPathCount(version: string): number {
  return Object.keys((loadSpec(version).spec.paths ?? {}) as Json).length
}

if (process.argv[1]?.endsWith("harbor-spec-diff.ts")) {
  const [fromVersion, toVersion] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"))
  if (!fromVersion || !toVersion) {
    console.error("usage: npx tsx tools/harbor-spec-diff.ts <fromVersion> <toVersion> [--json]")
    process.exit(2)
  }
  const comparisons = compareSpecs(fromVersion, toVersion)
  if (process.argv.includes("--record")) {
    // Contract evidence is written by this tool or not at all (plan §2): a hand-edited entry
    // could hand a capability an `expected` that no comparison ever supported.
    const path = resolve(new URL("..", import.meta.url).pathname, "docs/harbor-spec-evidence.json")
    const existing = JSON.parse(readFileSync(path, "utf8")) as { _note: string; comparisons: CapabilityComparison[] }
    const kept = existing.comparisons.filter(
      (entry) => !(entry.fromVersion === fromVersion && entry.toVersion === toVersion),
    )
    const merged = [...kept, ...comparisons].sort((a, b) =>
      `${a.fromVersion}->${a.toVersion}:${a.capabilityId}`.localeCompare(
        `${b.fromVersion}->${b.toVersion}:${b.capabilityId}`,
      ),
    )
    writeFileSync(path, JSON.stringify({ _note: existing._note, comparisons: merged }, null, 2) + "\n")
    console.log(`Recorded ${comparisons.length} comparisons for ${fromVersion} -> ${toVersion}.`)
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ comparisons }, null, 2))
  } else {
    for (const comparison of comparisons) {
      const total = comparison.breakingChanges.length + comparison.additions.length
      if (total === 0 && comparison.complete) continue
      console.log(`\n${comparison.capabilityId}  (${fromVersion} -> ${toVersion})`)
      for (const line of comparison.breakingChanges) console.log(`  BREAKING  ${line}`)
      for (const line of comparison.additions) console.log(`  addition  ${line}`)
      for (const line of comparison.incompleteReasons) console.log(`  INCOMPLETE ${line}`)
    }
    const breaking = comparisons.reduce((sum, c) => sum + c.breakingChanges.length, 0)
    const additions = comparisons.reduce((sum, c) => sum + c.additions.length, 0)
    const incomplete = comparisons.filter((c) => !c.complete).length
    console.log(
      `\n${breaking} breaking, ${additions} addition(s), ${incomplete} incomplete comparison(s) ` +
        `across ${comparisons.length} capabilities.`,
    )
  }
}
