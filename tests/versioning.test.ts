import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import YAML from "yaml"
import { checkVersions, compareVersions, parseVersion, prepareRelease, releaseNotes, VERSION_FILES } from "../scripts/versioning.mjs"
import { APP_VERSION } from "../src/lib/version"

function fixture() {
  return {
    "package.json": JSON.stringify({ name: "gateway", version: "0.1.0", scripts: { test: "node --test" } }),
    "package-lock.json": JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" }, "node_modules/example": { version: "9.0.0" } } }),
    "deploy/helm/tessark-gateway/Chart.yaml": '# Operator settings\nversion: 0.2.0\nappVersion: "0.1.0"\nkubeVersion: ">=1.27.0-0"\n',
    "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Preserve access when signing in again.\n",
  }
}

test("repository manifests and the app's displayed version agree", () => {
  const files = Object.fromEntries(VERSION_FILES.map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]))
  assert.equal(checkVersions(files).appVersion, APP_VERSION)
})

test("application and chart versions are independent, but appVersion and lockfile must agree", () => {
  assert.deepEqual(checkVersions(fixture()), { appVersion: "0.1.0", chartVersion: "0.2.0" })
  for (const versionAtRoot of [true, false]) {
    const files = fixture()
    files["package-lock.json"] = JSON.stringify({ version: versionAtRoot ? "9.0.0" : "0.1.0", packages: { "": { version: versionAtRoot ? "0.1.0" : "9.0.0" } } })
    assert.throws(() => checkVersions(files), /package-lock/)
  }
  const files = fixture()
  files["deploy/helm/tessark-gateway/Chart.yaml"] = "version: 0.2.0\nappVersion: 9.0.0\n"
  assert.throws(() => checkVersions(files), /appVersion/)
})

test("SemVer comparison handles prereleases and rejects invalid Docker release identifiers", () => {
  const order = ["0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.2", "0.2.0-alpha.10", "0.2.0-beta", "0.2.0-rc.1", "0.2.0", "0.2.1", "1.0.0"]
  for (let i = 1; i < order.length; i++) assert.equal(compareVersions(order[i - 1], order[i]), -1)
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-rc.01", "1.0.0+build.1", "1.0.0\nextra"]) {
    assert.throws(() => parseVersion(version), /Invalid release version/)
  }
})

test("preparing a release freezes notes and versions without altering dependency versions", () => {
  const files = fixture()
  const next = prepareRelease(files, "0.2.0-rc.1", "0.3.0-rc.1", "2026-09-11")
  assert.deepEqual(checkVersions(next, "v0.2.0-rc.1"), { appVersion: "0.2.0-rc.1", chartVersion: "0.3.0-rc.1" })
  assert.equal(JSON.parse(next["package.json"]).scripts.test, "node --test")
  assert.equal(JSON.parse(next["package-lock.json"]).packages["node_modules/example"].version, "9.0.0")
  const chart = YAML.parse(next["deploy/helm/tessark-gateway/Chart.yaml"])
  assert.equal(chart.kubeVersion, ">=1.27.0-0")
  assert.match(next["deploy/helm/tessark-gateway/Chart.yaml"], /# Operator settings/)
  assert.match(next["CHANGELOG.md"], /## \[Unreleased\]\n\n## \[0.2.0-rc.1\] - 2026-09-11/)
  assert.match(next["CHANGELOG.md"], /Chart Helm : `0.3.0-rc.1`/)
  assert.match(next["CHANGELOG.md"], /Preserve access/)
  assert.deepEqual(files, fixture(), "preparation must not mutate the input")
})

test("a tag requires both matching manifests and dated release notes", () => {
  assert.throws(() => checkVersions(fixture(), "v0.1.0"), /changelog entry/)
  const next = prepareRelease(fixture(), "0.2.0", "0.3.0", "2026-09-11")
  assert.throws(() => checkVersions(next, "v0.3.0"), /Release tag/)
  next["CHANGELOG.md"] = next["CHANGELOG.md"].replace("2026-09-11", "2026-02-30")
  assert.throws(() => checkVersions(next, "v0.2.0"), /release date/)
})

test("preparation refuses non-increasing versions, duplicate releases and empty notes", () => {
  assert.throws(() => prepareRelease(fixture(), "0.1.0", "0.3.0"), /application version must increase/)
  assert.throws(() => prepareRelease(fixture(), "0.2.0", "0.2.0"), /chart version must increase/)
  const files = fixture()
  files["CHANGELOG.md"] = "# Changelog\n\n## [Unreleased]\n"
  assert.throws(() => prepareRelease(files, "0.2.0", "0.3.0"), /Add changes/)
  files["CHANGELOG.md"] = fixture()["CHANGELOG.md"] + "\n## [0.2.0] - 2026-09-10\n\n- Already released.\n"
  assert.throws(() => prepareRelease(files, "0.2.0", "0.3.0"), /already contains/)
  files["CHANGELOG.md"] += "\n## [0.2.0] - 2026-09-11\n"
  assert.throws(() => checkVersions(files), /Duplicate/)
})

test("a later release preserves all previously published notes", () => {
  const first = prepareRelease(fixture(), "0.2.0-rc.1", "0.3.0-rc.1", "2026-09-11")
  first["CHANGELOG.md"] = first["CHANGELOG.md"].replace("## [Unreleased]", "## [Unreleased]\n\n- Promote the validated candidate to stable.")
  const next = prepareRelease(first, "0.2.0", "0.3.0", "2026-09-12")
  assert.match(next["CHANGELOG.md"], /## \[0.2.0\] - 2026-09-12/)
  assert.ok(next["CHANGELOG.md"].endsWith(first["CHANGELOG.md"].slice(first["CHANGELOG.md"].indexOf("## [0.2.0-rc.1]"))))
})

test("GitHub release notes include only the validated release, not pending or older changes", () => {
  const first = prepareRelease(fixture(), "0.2.0-rc.1", "0.3.0-rc.1", "2026-09-11")
  first["CHANGELOG.md"] = first["CHANGELOG.md"].replace("## [Unreleased]", "## [Unreleased]\n\n- Stable release changes.")
  const next = prepareRelease(first, "0.2.0", "0.3.0", "2026-09-12")
  next["CHANGELOG.md"] = next["CHANGELOG.md"].replace("## [Unreleased]", "## [Unreleased]\n\n- Future changes.")
  const notes = releaseNotes(next, "v0.2.0")
  assert.match(notes, /Stable release changes/)
  assert.match(notes, /Chart Helm : `0.3.0`/)
  assert.doesNotMatch(notes, /Future changes|Preserve access|rc\.1/)
  assert.throws(() => releaseNotes(next, "v0.2.0-rc.1"), /Release tag/)
  assert.throws(() => releaseNotes(fixture(), "v0.1.0"), /changelog entry/)
})
