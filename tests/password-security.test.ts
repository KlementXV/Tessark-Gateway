import assert from "node:assert/strict"
import { test } from "node:test"
import { isWeakRegistryPassword } from "../src/lib/registries/password-security"

test("flags short, default, repetitive and username passwords", () => {
  for (const value of ["Harbor12345", "password123456789!", "a".repeat(30), "tiny"]) {
    assert.equal(isWeakRegistryPassword(value), true)
  }
  assert.equal(isWeakRegistryPassword("DedicatedAccount", "dedicatedaccount"), true)
})

test("accepts long passphrases without arbitrary character-class requirements", () => {
  assert.equal(isWeakRegistryPassword("orchard lantern river violet"), false)
  assert.equal(isWeakRegistryPassword("6rPb9_Jz8Wm2!Qv5tXs4"), false)
})
