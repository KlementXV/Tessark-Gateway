#!/usr/bin/env bash
# Exercise the shipped image against a disposable PostgreSQL instance, without local env files.
set -euo pipefail

image="${1:?Usage: bash scripts/test-image.sh IMAGE}"
prefix="tessark-ci-${RANDOM}-$$"
network="${prefix}-network"
database="${prefix}-postgres"
application="${prefix}-app"
network_created=false
database_created=false
application_created=false

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    if $application_created; then docker logs "$application" || true; fi
    if $database_created; then docker logs "$database" || true; fi
  fi
  if $application_created; then docker rm -f "$application" >/dev/null || true; fi
  if $database_created; then docker rm -f "$database" >/dev/null || true; fi
  if $network_created; then docker network rm "$network" >/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT

# The production image keeps CLI hooks but must never ship the builder's full dependency tree.
docker run --rm -i --network none --entrypoint node "$image" <<'JS'
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
for (const name of ['eslint', 'typescript', 'shadcn', '@tailwindcss/postcss']) {
  assert.equal(existsSync(`/app/node_modules/${name}`), false, `build-only package shipped: ${name}`);
}
for (const file of ['node_modules/.bin/prisma', 'node_modules/.bin/tsx', 'prisma/seed.ts', 'tsconfig.json', 'src/lib/config.ts']) {
  assert.ok(existsSync(`/app/${file}`), `runtime tooling missing: ${file}`);
}
console.log('Runtime packaging passed: CLI hooks present, build toolchain absent.');
JS

docker network create "$network" >/dev/null
network_created=true
docker run -d --name "$database" --network "$network" --network-alias postgres \
  -e POSTGRES_USER=tessark -e POSTGRES_PASSWORD=ci-database-password \
  -e POSTGRES_DB=tessark_ci postgres:17-alpine >/dev/null
database_created=true

ready=false
for _ in {1..60}; do
  if docker exec "$database" pg_isready -U tessark -d tessark_ci >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
$ready || { echo 'PostgreSQL did not become ready.' >&2; exit 1; }

runtime=(
  --network "$network"
  --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777
  --cap-drop ALL --security-opt no-new-privileges
  -e 'DATABASE_URL=postgresql://tessark:ci-database-password@postgres:5432/tessark_ci?schema=public&connection_limit=5'
  -e AUTH_SECRET=ci-session-secret-not-for-production-000000
  -e GATEWAY_SECRET_KEY=ci-encryption-key-not-for-production-000000
  -e GATEWAY_ADMIN_USERNAME=ci-admin
  -e GATEWAY_ADMIN_PASSWORD=ci-admin-password
  -e AUTH_URL=http://localhost:3000
  -e K8S_ENABLED=false
  -e REPLICATION_WORKER_ENABLED=false
  -e BUILDS_BETA_ENABLED=false
  -e NEXT_TELEMETRY_DISABLED=1
)

docker run --rm "${runtime[@]}" --entrypoint npx "$image" prisma migrate deploy
docker run --rm "${runtime[@]}" --entrypoint npx "$image" prisma db seed
# A second seed must neither duplicate nor reset the existing administrator.
docker run --rm "${runtime[@]}" -e GATEWAY_ADMIN_PASSWORD=must-not-reset-existing-password \
  --entrypoint npx "$image" prisma db seed

docker run --rm -i "${runtime[@]}" --entrypoint node "$image" <<'JS'
const assert = require('node:assert/strict');
const { scryptSync, timingSafeEqual } = require('node:crypto');
const { PrismaClient } = require('/app/src/generated/prisma/index.js');
const db = new PrismaClient();
(async () => {
  try {
    const users = await db.user.findMany();
    assert.equal(users.length, 1, 'seed must be idempotent');
    assert.equal(users[0].username, 'ci-admin');
    assert.equal(users[0].role, 'SUPERADMIN');
    const [salt, hash] = users[0].passwordHash.split(':');
    assert.ok(timingSafeEqual(scryptSync('ci-admin-password', Buffer.from(salt, 'base64'), 64), Buffer.from(hash, 'base64')),
      're-seeding must preserve the original password');
  } finally {
    await db.$disconnect();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS

docker run -d --name "$application" "${runtime[@]}" "$image" >/dev/null
application_created=true
ready=false
for _ in {1..60}; do
  if docker exec "$application" node -e \
    'fetch("http://127.0.0.1:3000/api/ready").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' \
    >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
$ready || { echo 'Gateway did not become ready.' >&2; exit 1; }

docker exec -i "$application" node <<'JS'
const assert = require('node:assert/strict');
(async () => {
  const base = 'http://127.0.0.1:3000';
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const readiness = await fetch(`${base}/api/ready`);
  assert.equal(readiness.status, 200);
  const checks = (await readiness.json()).checks;
  assert.equal(checks.config, 'ok');
  assert.equal(checks.database, 'ok');
  assert.equal((await fetch(`${base}/login`)).status, 200);
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  const spec = await fetch(`${base}/api/openapi.json`);
  assert.equal(spec.status, 200);
  assert.match((await spec.json()).openapi, /^3\.1\./);
  assert.equal((await fetch(`${base}/api/docs`)).status, 200);
  assert.equal((await fetch(`${base}/swagger-ui/swagger-ui-bundle.js`)).status, 200);
  console.log('Image passed: migrations, idempotent seed, password preservation, readiness, login, auth boundary and Swagger.');
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
