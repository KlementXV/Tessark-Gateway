import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import YAML from "yaml"

export const VERSION_FILES = ["package.json", "package-lock.json", "deploy/helm/tessark-gateway/Chart.yaml", "CHANGELOG.md"]
const [PACKAGE, LOCK, CHART, CHANGELOG] = VERSION_FILES

// Release identifiers are SemVer without build metadata (+...), which Docker tags cannot use.
export function parseVersion(value) {
  const match = typeof value === "string" && value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/)
  if (!match || match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`Invalid release version: ${value}. Use 1.2.3 or 1.2.3-rc.1, without a v prefix or +metadata.`)
  }
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") ?? [] }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    if (a.pre[i] === b.pre[i]) continue
    const numericA = /^\d+$/.test(a.pre[i])
    const numericB = /^\d+$/.test(b.pre[i])
    if (numericA && numericB) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1
    if (numericA !== numericB) return numericA ? -1 : 1
    return a.pre[i] > b.pre[i] ? 1 : -1
  }
  return 0
}

function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
}

function sections(changelog) {
  const headings = [...changelog.matchAll(/^## (.+)$/gm)]
  const seen = new Set()
  const entries = headings.map((heading, index) => {
    const parsed = heading[1].match(/^\[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/)
    if (!parsed) throw new Error(`Invalid changelog heading: ${heading[0]}`)
    const [, version, date] = parsed
    if (seen.has(version)) throw new Error(`Duplicate changelog section: ${version}`)
    seen.add(version)
    if (version !== "Unreleased") {
      parseVersion(version)
      if (!date || !validDate(date)) throw new Error(`Missing or invalid release date for ${version}`)
    } else if (date) throw new Error("Unreleased must not have a release date")
    const end = headings[index + 1]?.index ?? changelog.length
    return { version, start: heading.index, end, body: changelog.slice(heading.index + heading[0].length, end).trim() }
  })
  if (entries[0]?.version !== "Unreleased") throw new Error("The first changelog section must be ## [Unreleased]")
  return entries
}

export function checkVersions(files, tag) {
  const pkg = JSON.parse(files[PACKAGE])
  const lock = JSON.parse(files[LOCK])
  const chart = YAML.parse(files[CHART])
  parseVersion(pkg.version)
  parseVersion(chart.version)
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package-lock.json must match package.json.version at both root locations")
  }
  if (chart.appVersion !== pkg.version) throw new Error("Chart.yaml appVersion must match package.json.version")
  const entries = sections(files[CHANGELOG])
  if (tag !== undefined) {
    if (tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}, received ${tag}`)
    const entry = entries.find((entry) => entry.version === pkg.version)
    if (!entry || !/^- \S/m.test(entry.body)) throw new Error(`A dated, nonempty changelog entry for ${pkg.version} is required before tagging`)
  }
  return { appVersion: pkg.version, chartVersion: chart.version }
}

export function releaseNotes(files, tag) {
  const { appVersion } = checkVersions(files, tag)
  const entry = sections(files[CHANGELOG]).find((entry) => entry.version === appVersion)
  if (!entry) throw new Error(`No release notes for ${appVersion}`)
  return `${entry.body}\n`
}

// Prepare all content in memory and validate it before writing any file. No Git operations.
export function prepareRelease(files, appVersion, chartVersion, date = new Date().toISOString().slice(0, 10)) {
  const current = checkVersions(files)
  if (compareVersions(appVersion, current.appVersion) <= 0) throw new Error("The application version must increase")
  if (compareVersions(chartVersion, current.chartVersion) <= 0) throw new Error("The chart version must increase when its appVersion changes")
  if (!validDate(date)) throw new Error("Invalid release date")
  const entries = sections(files[CHANGELOG])
  if (entries.some((entry) => entry.version === appVersion)) throw new Error(`Changelog already contains ${appVersion}`)
  const pending = entries[0]
  if (!/^- \S/m.test(pending.body)) throw new Error("Add changes to Unreleased before preparing a release")

  const pkg = JSON.parse(files[PACKAGE])
  const lock = JSON.parse(files[LOCK])
  pkg.version = appVersion
  lock.version = appVersion
  lock.packages[""].version = appVersion
  const chart = YAML.parseDocument(files[CHART])
  chart.set("version", chartVersion)
  chart.set("appVersion", appVersion)
  const next = {
    ...files,
    [PACKAGE]: `${JSON.stringify(pkg, null, 2)}\n`,
    [LOCK]: `${JSON.stringify(lock, null, 2)}\n`,
    [CHART]: chart.toString(),
    [CHANGELOG]: files[CHANGELOG].slice(0, pending.start)
      + `## [Unreleased]\n\n## [${appVersion}] - ${date}\n\nChart Helm : \`${chartVersion}\`.\n\n${pending.body}\n\n`
      + files[CHANGELOG].slice(pending.end),
  }
  checkVersions(next, `v${appVersion}`)
  return next
}

function main(args) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const files = Object.fromEntries(VERSION_FILES.map((file) => [file, readFileSync(resolve(root, file), "utf8")]))
  if (args[0] === "notes" && args.length === 3 && args[1] === "--tag") {
    process.stdout.write(releaseNotes(files, args[2]))
    return
  }
  if (args[0] === "check" && (args.length === 1 || (args.length === 3 && args[1] === "--tag"))) {
    const versions = checkVersions(files, args[2])
    console.log(`Versions consistent: app ${versions.appVersion}, chart ${versions.chartVersion}${args[2] ? `, tag ${args[2]}` : ""}.`)
    return
  }
  if (args[0] === "prepare" && (args.length === 4 || (args.length === 5 && args[4] === "--dry-run")) && args[2] === "--chart") {
    const next = prepareRelease(files, args[1], args[3])
    if (args[4] !== "--dry-run") {
      for (const file of VERSION_FILES) writeFileSync(resolve(root, file), next[file])
    }
    console.log(`${args[4] === "--dry-run" ? "Would prepare" : "Prepared"} app ${args[1]}, chart ${args[3]} in ${VERSION_FILES.join(", ")}.`)
    console.log("Review the diff and upgrade notes, run validation, then commit. No commit, tag or publication was created.")
    return
  }
  throw new Error("Usage: versioning.mjs check [--tag v1.2.3] | notes --tag v1.2.3 | prepare 1.2.3 --chart 1.3.0 [--dry-run]")
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)) } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
