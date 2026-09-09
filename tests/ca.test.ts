import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"

import { caFingerprint, enterpriseCaPemField, normalizeCaPem } from "@/lib/ca"

const cert = `-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----`

test("normalizes a PEM CA bundle and fingerprints it deterministically", () => {
  const pem = normalizeCaPem(`\r\n${cert}\r\n`)
  assert.equal(pem, `${cert}\n`)
  assert.equal(caFingerprint(pem).length, 64)
})

test("rejects private keys and non PEM content", () => {
  assert.throws(() => normalizeCaPem(`${cert}\nprivate-key`), /unsupported content/)
  assert.throws(() => normalizeCaPem("hello"), /between 1 and 10/)
})

test("deduplicates a certificate pasted twice", () => {
  const pem = normalizeCaPem(`${cert}\n${cert}\n`)
  assert.equal(pem, `${cert}\n`)
})

test("refuses a bundle while the beta flag is off", () => {
  // tests/env.fixture leaves CUSTOM_CA_BETA_ENABLED unset, i.e. the shipped default.
  const parsed = z.object({ pem: enterpriseCaPemField() }).safeParse({ pem: cert })
  assert.equal(parsed.success, false)
  assert.match(parsed.error!.issues[0].message, /CUSTOM_CA_BETA_ENABLED/)
})

test("an omitted or null bundle is accepted whatever the flag says", () => {
  const schema = z.object({ pem: enterpriseCaPemField() })
  assert.equal(schema.safeParse({}).success, true)
  assert.equal(schema.safeParse({ pem: null }).success, true)
})
