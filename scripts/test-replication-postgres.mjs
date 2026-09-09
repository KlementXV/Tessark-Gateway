/* eslint-disable no-restricted-syntax -- Test harness must supply an isolated DATABASE_URL to child migration processes. */
// Integration test against an isolated schema in the configured PostgreSQL database.
// No Harbor requests: this verifies migrations and real cross-connection lock exclusion.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { PrismaClient } from '../src/generated/prisma/index.js'

config({ path: '.env.local', quiet: true })
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const schema = `replication_test_${randomUUID().replaceAll('-', '')}`
const url = new URL(process.env.DATABASE_URL)
url.searchParams.set('schema', schema)
url.searchParams.set('connection_limit', '5')
const isolatedUrl = url.toString()
const first = new PrismaClient({ datasourceUrl: isolatedUrl })
const second = new PrismaClient({ datasourceUrl: isolatedUrl })
try {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: isolatedUrl }, stdio: 'pipe',
  })
  const tables = await first.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema}`
  assert.ok(tables.some((table) => table.table_name === 'ReplicationCleanup'))
  const columns = await first.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = 'ReplicationLink'`
  assert.ok(columns.some((column) => column.column_name === 'executionId'))
  // Real lock keys are scoped to the database. Use a test-only key to leave live Gateway
  // maintenance alone while reproducing exactly the two-connection ownership protocol.
  await first.$transaction(async (tx) => {
    const [owner] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(742019, 987654) AS acquired`
    assert.equal(owner.acquired, true)
    await second.$transaction(async (other) => {
      const [contender] = await other.$queryRaw`SELECT pg_try_advisory_xact_lock(742019, 987654) AS acquired`
      assert.equal(contender.acquired, false)
    })
  })
  await assert.rejects(first.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(742019, 987654) AS acquired`
    throw new Error('simulated owner failure')
  }), /simulated owner failure/)
  await second.$transaction(async (tx) => {
    const [successor] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(742019, 987654) AS acquired`
    assert.equal(successor.acquired, true)
  })
  // Transfer approval/rejection uses a separate, per-request advisory lock namespace.
  await first.$transaction(async (tx) => {
    const [owner] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(742021, hashtext(${schema})) AS acquired`
    assert.equal(owner.acquired, true)
    await second.$transaction(async (other) => {
      const [contender] = await other.$queryRaw`SELECT pg_try_advisory_xact_lock(742021, hashtext(${schema})) AS acquired`
      assert.equal(contender.acquired, false)
      const [independent] = await other.$queryRaw`SELECT pg_try_advisory_xact_lock(742021, hashtext(${schema + '_other'})) AS acquired`
      assert.equal(independent.acquired, true)
    })
  })
  await second.$transaction(async (tx) => {
    const [successor] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(742021, hashtext(${schema})) AS acquired`
    assert.equal(successor.acquired, true)
  })
  await first.replicationCleanup.create({ data: {
    id: 'pending-removal', sourceRegistryId: 'deleted-source', destRegistryId: 'deleted-destination',
    encryptedConnection: 'test-ciphertext', harborPolicyId: 12,
  } })
  await first.$disconnect()
  assert.equal((await second.replicationCleanup.findUnique({ where: { id: 'pending-removal' } }))?.harborPolicyId, 12)
  console.log('PostgreSQL: migrations, cross-connection exclusion, failure release and durable cleanup passed.')
} catch (error) {
  // Do not dump child-process env or the connection URL on migration failure.
  throw new Error(error instanceof Error ? error.message.split('\n')[0] : 'Integration test failed')
} finally {
  // The identifier is generated above, never supplied by a user or external service.
  await second.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await Promise.all([first.$disconnect(), second.$disconnect()])
}
