import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import YAML from "yaml"

function workflow(name: string) {
  return YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"))
}

const ci = workflow("ci")
type Step = { name?: string; uses?: string; if?: string; run?: string }

for (const [event, ref, requested, publishes] of [
  ["push", "refs/heads/main", false, true],
  ["push", "refs/tags/v0.2.0", false, true],
  ["push", "refs/heads/release/v0.2.0", false, false],
  ["pull_request", "refs/pull/1/merge", false, false],
  ["pull_request", "refs/tags/v0.2.0", true, false],
  ["workflow_dispatch", "refs/heads/main", false, false],
  ["workflow_dispatch", "refs/heads/main", true, false],
  ["workflow_dispatch", "refs/heads/release/v0.2.0", true, false],
  ["workflow_dispatch", "refs/tags/v0.2.0", false, false],
  ["workflow_dispatch", "refs/tags/v0.2.0", true, true],
  ["workflow_dispatch", "refs/tags/v0.2.0-rc.1", true, true],
] as const) {
  test(`publication boundary: ${event} ${ref}, requested=${requested}`, () => {
    const context = {
      github: { event_name: event, ref },
      inputs: { publish_release: requested },
      startsWith: (value: string, prefix: string) => value.startsWith(prefix),
    }
    assert.equal(runInNewContext(ci.jobs.publish.if, context), publishes)
    if (publishes) {
      for (const name of ["Export the tested image", "Upload the tested image"]) {
        const step = ci.jobs.image.steps.find((step: Step) => step.name === name)
        assert.ok(step)
        assert.equal(runInNewContext(step.if, context), true, "publication needs an artifact from the same tested run")
      }
    }
  })
}

test("publication depends on validation and runs without checking out application code", () => {
  assert.deepEqual(ci.jobs.publish.needs, ["checks", "tests", "postgres", "chart", "image"])
  assert.ok(ci.jobs.release.needs.includes("publish"))
  for (const job of [ci.jobs.publish, ci.jobs.release]) {
    assert.equal(job.steps.some((step: Step) => step.uses?.startsWith("actions/checkout@")), false)
  }
  assert.equal(ci.on.workflow_dispatch.inputs.publish_release.default, false)
  assert.equal(ci.jobs.release.permissions.contents, "write")
  assert.equal(ci.jobs.publish.permissions.packages, "write")
})

test("release entry points are manual, serialize changes, and use only main", () => {
  for (const name of ["prepare-release", "publish-release"]) {
    const release = workflow(name)
    assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"])
    assert.equal(release.concurrency["cancel-in-progress"], false)
    const job = Object.values(release.jobs)[0] as { steps: Step[]; permissions: Record<string, string> }
    assert.equal(job.steps[0].run, 'test "$GITHUB_REF" = refs/heads/main')
    assert.equal(job.permissions.actions, "write")
    const commands = job.steps.map((step) => step.run ?? "").join("\n")
    assert.match(commands, /gh workflow run ci\.yml/)
    assert.doesNotMatch(commands, /--force|git push -f|gh pr merge/)
  }
})
