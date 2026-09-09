import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"

import { logger } from "../src/lib/logger"

// eslint-disable-next-line no-restricted-syntax -- Tests temporarily switch NODE_ENV to exercise production log formatting.
const testEnv: Record<string, string | undefined> = process.env
const originalNodeEnv = testEnv.NODE_ENV

afterEach(() => {
  mock.restoreAll()
  if (originalNodeEnv === undefined) delete testEnv.NODE_ENV
  else testEnv.NODE_ENV = originalNodeEnv
})

test("production logs retain Error details and stay JSON serializable", () => {
  testEnv.NODE_ENV = "production"
  const write = mock.method(console, "error", () => {})
  const cause = new Error("database unavailable")
  const error = new Error("transfer failed", { cause })

  logger.error("Skopeo Job launch failed", {
    error,
    startedAt: new Date("2026-09-06T12:00:00.000Z"),
    bytes: BigInt(42),
  })

  assert.equal(write.mock.callCount(), 1)
  const record = JSON.parse(String(write.mock.calls[0].arguments[0]))
  assert.equal(record.level, "error")
  assert.equal(record.msg, "Skopeo Job launch failed")
  assert.equal(record.startedAt, "2026-09-06T12:00:00.000Z")
  assert.equal(record.bytes, "42")
  assert.equal(record.error.name, "Error")
  assert.equal(record.error.message, "transfer failed")
  assert.match(record.error.stack, /transfer failed/)
  assert.equal(record.error.cause.message, "database unavailable")
})

test("redaction also applies to child context and fixed envelope fields cannot be replaced", () => {
  testEnv.NODE_ENV = "production"
  const write = mock.method(console, "log", () => {})

  logger
    .child({ jobName: "transfer-42", apiToken: "child-secret", level: "forged" })
    .info("job started", { password: "request-secret", level: "also-forged", msg: "fake", time: "never" })

  assert.equal(write.mock.callCount(), 1)
  const record = JSON.parse(String(write.mock.calls[0].arguments[0]))
  assert.equal(record.jobName, "transfer-42")
  assert.equal(record.apiToken, "[redacted]")
  assert.equal(record.password, "[redacted]")
  assert.equal(record.level, "info")
  assert.equal(record.msg, "job started")
  assert.match(record.time, /^\d{4}-\d\d-\d\dT/)
})
