/**
 * Extracts the Harbor API surface the Gateway actually calls, straight from the source.
 *
 * The matrix is only honest if its list of operations comes from the code rather than from a
 * hand-kept list that drifts: a call added without a capability to answer for it is exactly the
 * gap this file exists to close (see docs/plan-harbor-compatibility.md, lot 1).
 *
 * The scan goes through the TypeScript AST, not a regex, because Harbor URLs in
 * src/lib/registries/harbor.ts are template literals concatenated across lines:
 *
 *   `/api/v2.0/projects/${encodeURIComponent(name)}/repositories/${encode(repo)}` +
 *     `/artifacts?page_size=1`
 *
 * A regex sees two unrelated fragments there; the AST sees one expression. Comments are also
 * invisible to the AST, which matters here: harbor.ts documents `/api/v2.0/` in prose.
 *
 * Run with: npx tsx tools/harbor-surface.ts [--check | --json | --files]
 */
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"
import ts from "typescript"

import { HARBOR_CAPABILITIES } from "../src/lib/registries/harbor-capabilities"

/** Harbor's API root. Everything the Gateway calls hangs off it. */
const API_ROOT = "/api/v2.0"

/** What one call site looks like once the dynamic parts are collapsed. */
export interface HarborCallSite {
  /** "GET" unless the fetch options carry an explicit method. */
  method: string
  /** Path below /api/v2.0, with every interpolation collapsed to {} — "/projects/{}/members". */
  path: string
  /** Repo-relative file the call lives in. */
  file: string
  line: number
}

/** One distinct operation, with every file that reaches it. */
export interface HarborOperation {
  method: string
  path: string
  files: string[]
}

/** Collapses an interpolated path to its shape: `/projects/${x}/members` -> "/projects/{}/members". */
export function normalizePath(raw: string): string | null {
  const withoutQuery = raw.split("?")[0]
  // A path with whitespace in it is prose, not a URL: check.ts quotes "/api/v2.0/ping" inside
  // the message shown when a registry turns out not to be a Harbor. Counting that as a call
  // site would attribute the ping operation to a file that never issues it, and put that file
  // in the digest that decides when the ping capability loses its certification.
  if (/\s/.test(withoutQuery)) return null
  const belowRoot = withoutQuery.slice(API_ROOT.length)
  const trimmed = belowRoot.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/**
 * Renders an expression as a static shape, or null when it is not string-ish.
 *
 * Anything interpolated becomes "{}": the identity of a path parameter is irrelevant here, and
 * pretending to recover it (`${id}` -> `{id}`) would invent a correspondence with the upstream
 * spec's own parameter names that nothing guarantees.
 */
function shapeOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => "{}" + span.literal.text).join("")
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = shapeOf(node.left)
    const right = shapeOf(node.right)
    return left === null || right === null ? null : left + right
  }
  if (ts.isParenthesizedExpression(node)) return shapeOf(node.expression)
  return null
}

/**
 * The HTTP method of the call this path belongs to.
 *
 * registryFetch() mirrors fetch(): the method lives in an options object beside the path, and
 * its absence means GET. Walking up to the enclosing call and reading that literal is the only
 * way to tell `GET /projects` from `POST /projects`, which are different operations with
 * different histories in the upstream spec.
 */
function methodOf(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue
    for (const argument of current.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const name = property.name.getText()
        if (name !== "method" && name !== '"method"') continue
        const value = shapeOf(property.initializer)
        if (value) return value.toUpperCase()
      }
    }
    return "GET"
  }
  return "GET"
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "generated" || entry.startsWith(".")) continue
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Every Harbor call site under `root`, in source order. */
export function collectCallSites(root: string): HarborCallSite[] {
  const sites: HarborCallSite[] = []

  for (const file of sourceFiles(resolve(root, "src"))) {
    const text = readFileSync(file, "utf8")
    if (!text.includes(API_ROOT)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

    const visit = (node: ts.Node): void => {
      const shape = shapeOf(node)
      if (shape?.includes(API_ROOT)) {
        const path = normalizePath(shape.slice(shape.indexOf(API_ROOT)))
        // Do not descend either way: the fragments of a concatenation would each be reported
        // again, and a rejected shape has no sub-expression worth re-examining.
        if (path !== null) {
          sites.push({
            method: methodOf(node),
            path,
            file: relative(root, file),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          })
        }
        return
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
  }

  return sites
}

/** Call sites folded into distinct operations. */
export function collectOperations(root: string): HarborOperation[] {
  const byKey = new Map<string, HarborOperation>()
  for (const site of collectCallSites(root)) {
    const key = `${site.method} ${site.path}`
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.files.includes(site.file)) existing.files.push(site.file)
    } else {
      byKey.set(key, { method: site.method, path: site.path, files: [site.file] })
    }
  }
  return [...byKey.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))
}

/**
 * A digest over the files implementing a set of operations.
 *
 * This is what bounds proof invalidation (plan §2): a commit that leaves every file behind a
 * capability untouched leaves its digest — and therefore its certification — intact, while a
 * commit inside one invalidates that capability and no other. Hashing content rather than
 * reading git means it works in this repo today, which has no git history at all.
 */
export function digestFiles(root: string, files: string[]): string {
  const hash = createHash("sha256")
  for (const file of [...files].sort()) {
    hash.update(file)
    hash.update("\0")
    hash.update(createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex"))
    hash.update("\n")
  }
  return hash.digest("hex").slice(0, 16)
}

/**
 * Ties the extracted surface to the catalogue.
 *
 * Two directions, both of which have to hold: every operation the code issues must be claimed by
 * a capability — otherwise a new Harbor call ships with nothing in the matrix answering for it —
 * and every operation a capability declares must actually be issued, or the catalogue is
 * describing code that no longer exists.
 */
export interface SurfaceReconciliation {
  operations: HarborOperation[]
  /** Issued by the code, claimed by no capability. */
  unclaimed: string[]
  /** Declared by a capability, issued nowhere. */
  phantom: Array<{ capabilityId: string; operation: string }>
  /** Files behind each capability, and the digest that bounds its proof invalidation. */
  capabilities: Array<{ id: string; files: string[]; digest: string }>
}

export function reconcileSurface(root: string): SurfaceReconciliation {
  const operations = collectOperations(root)
  const byKey = new Map(operations.map((operation) => [`${operation.method} ${operation.path}`, operation]))
  const claimed = new Set<string>()
  const phantom: SurfaceReconciliation["phantom"] = []
  const capabilities: SurfaceReconciliation["capabilities"] = []

  for (const capability of HARBOR_CAPABILITIES) {
    const files = new Set<string>()
    for (const operation of capability.operations) {
      const found = byKey.get(operation)
      if (!found) {
        phantom.push({ capabilityId: capability.id, operation })
        continue
      }
      claimed.add(operation)
      for (const file of found.files) files.add(file)
    }
    const sorted = [...files].sort()
    capabilities.push({ id: capability.id, files: sorted, digest: digestFiles(root, sorted) })
  }

  return {
    operations,
    unclaimed: [...byKey.keys()].filter((key) => !claimed.has(key)).sort(),
    phantom,
    capabilities,
  }
}

/** Per-capability digests, in the shape evaluateCapability() expects. */
export function surfaceDigests(root: string): Record<string, string> {
  return Object.fromEntries(reconcileSurface(root).capabilities.map((entry) => [entry.id, entry.digest]))
}

if (process.argv[1]?.endsWith("harbor-surface.ts")) {
  const root = resolve(new URL("..", import.meta.url).pathname)
  const reconciliation = reconcileSurface(root)

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(reconciliation, null, 2))
  } else if (process.argv.includes("--check")) {
    for (const operation of reconciliation.unclaimed) {
      console.error(`No capability claims ${operation} — add it to HARBOR_CAPABILITIES.`)
    }
    for (const { capabilityId, operation } of reconciliation.phantom) {
      console.error(`Capability ${capabilityId} declares ${operation}, which no code issues.`)
    }
    if (reconciliation.unclaimed.length > 0 || reconciliation.phantom.length > 0) process.exit(1)
    console.log(
      `harbor surface: ${reconciliation.operations.length} operations, all claimed by ` +
        `${reconciliation.capabilities.length} capabilities.`,
    )
  } else {
    for (const operation of reconciliation.operations) {
      const where = process.argv.includes("--files") ? `  <- ${operation.files.join(", ")}` : ""
      console.log(`${operation.method.padEnd(6)} ${operation.path}${where}`)
    }
    console.log("")
    for (const capability of reconciliation.capabilities) {
      console.log(`${capability.digest}  ${capability.id.padEnd(22)} ${capability.files.length} file(s)`)
    }
  }
}
