// The beta flag is read once per process and memoized (src/lib/config.ts), so the enabled path
// gets a file of its own: setting the variable here, before anything calls getConfig(), is what
// makes both sides of the flag testable at all.
//
// A test setting up its own environment is exactly what the "no scattered process.env" rule
// is protecting the application code from.
// eslint-disable-next-line no-restricted-syntax
process.env.CUSTOM_CA_BETA_ENABLED = "true"

import assert from "node:assert/strict"
import test from "node:test"

import { buildSkopeoJobSpec } from "@/lib/transfers/job-spec"
import {
  transferRequestBatchInputSchema,
  transferRequestCreateInputSchema,
} from "@/lib/transfers/schema"
import { enterpriseCaInputSchema } from "@/lib/settings/schema"

const cert = `-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----`

test("the enterprise CA settings field normalises, removes and refuses", () => {
  const saved = enterpriseCaInputSchema.safeParse({ enterpriseCaPem: `\r\n${cert}\r\n` })
  assert.equal(saved.success, true)
  assert.equal(saved.data!.enterpriseCaPem, `${cert}\n`)

  // null removes it; an empty string is neither a bundle nor a removal.
  assert.equal(enterpriseCaInputSchema.safeParse({ enterpriseCaPem: null }).success, true)
  assert.equal(enterpriseCaInputSchema.safeParse({ enterpriseCaPem: "" }).success, false)
  assert.equal(enterpriseCaInputSchema.safeParse({ enterpriseCaPem: `${cert}\nkey` }).success, false)
})

function spec(input: Partial<Parameters<typeof buildSkopeoJobSpec>[0]>) {
  return JSON.stringify(
    buildSkopeoJobSpec({
      secretName: "transfer-1-creds",
      sourceImage: "docker.io/library/nginx:latest",
      destImage: "harbor.example.test/apps/nginx:latest",
      sourceArgs: "",
      labels: {},
      ...input,
    }),
  )
}

test("no enterprise CA leaves the job spec exactly as it was", () => {
  const json = spec({})
  assert.equal(json.includes("cert-dir"), false)
  assert.equal(json.includes("-ca"), false)
})

test("one bundle is projected into both ends, each under its own directory", () => {
  const json = spec({ caPem: cert })
  assert.match(json, /--src-cert-dir=\/etc\/tessark\/certs\/source/)
  assert.match(json, /--src-tls-verify=true/)
  assert.match(json, /--dest-cert-dir=\/etc\/tessark\/certs\/destination/)
  assert.match(json, /--dest-tls-verify=true/)
  assert.match(json, /"secretName":"transfer-1-creds-ca"/)
  assert.match(json, /"key":"ca.crt","path":"ca.crt"/)
})

test("a side declared insecure takes no CA, and does not stop the other side from having one", () => {
  // Insecure wins per side: that registry was marked unverified on purpose, and pointing skopeo
  // at a trust store for a connection it will not check is noise.
  const sourceInsecure = spec({ caPem: cert, sourceInsecure: true })
  assert.match(sourceInsecure, /--src-tls-verify=false/)
  assert.equal(sourceInsecure.includes("--src-cert-dir"), false)
  assert.match(sourceInsecure, /--dest-cert-dir/)

  const bothInsecure = spec({ caPem: cert, sourceInsecure: true, destInsecure: true })
  assert.equal(bothInsecure.includes("cert-dir"), false)
  assert.equal(bothInsecure.includes("-ca"), false)
})

test("the settings route takes each field on its own", () => {
  // Flipping the copy-job default must not require re-pasting the certificate, so both fields
  // are optional — the route is what refuses a body naming neither.
  const onlyDefault = enterpriseCaInputSchema.safeParse({ enterpriseCaJobDefault: false })
  assert.equal(onlyDefault.success, true)
  assert.equal(onlyDefault.data!.enterpriseCaPem, undefined)
  assert.equal(onlyDefault.data!.enterpriseCaJobDefault, false)
})

test("a transfer that says nothing about the CA stays undecided until the instance answers", () => {
  const body = {
    sourceId: "src_1",
    repo: "library/nginx",
    targets: [{ projectId: "prj_1", targetRepo: null }],
  }

  // No zod default any more: "said nothing" has to survive as far as the route, which resolves
  // it against InstanceSettings.enterpriseCaJobDefault. A default of `true` here would make an
  // instance that turned copy jobs off silently ignore its own setting.
  const implicit = transferRequestCreateInputSchema.safeParse(body)
  assert.equal(implicit.success, true)
  assert.equal(implicit.data!.useCustomCa, undefined)

  for (const value of [true, false]) {
    const explicit = transferRequestCreateInputSchema.safeParse({ ...body, useCustomCa: value })
    assert.equal(explicit.success, true)
    assert.equal(explicit.data!.useCustomCa, value)
  }
})

test("a batch refuses a repeated image, naming the line it came from", () => {
  const body = {
    sourceId: "src_1",
    targets: [{ projectId: "prj_1", targetRepo: null }],
  }

  const ok = transferRequestBatchInputSchema.safeParse({
    ...body,
    images: [{ repo: "library/nginx", tag: "1.27" }, { repo: "library/nginx", tag: "1.28" }],
  })
  assert.equal(ok.success, true)

  // Refused rather than deduplicated: a repeat in a pasted list is usually a mistake in the
  // list, and silently dropping it hides that.
  const dup = transferRequestBatchInputSchema.safeParse({
    ...body,
    images: [{ repo: "library/nginx" }, { repo: "library/redis" }, { repo: "library/nginx" }],
  })
  assert.equal(dup.success, false)
  assert.match(dup.error!.issues[0].message, /library\/nginx:latest is already on line 1/)

  // The source rule of the single form still holds for a list.
  const twoSources = transferRequestBatchInputSchema.safeParse({
    ...body,
    sourceRegistryId: "reg_1",
    sourceProjectName: "apps",
    images: [{ repo: "library/nginx" }],
  })
  assert.equal(twoSources.success, false)
})
