import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';
import YAML from 'yaml';

const chart = 'deploy/helm/tessark-gateway';
function render(overrides = [], operator = true) {
  const args = ['template', 'gateway-test', chart, '--namespace', 'gateway-test'];
  if (operator) args.push('--api-versions', 'postgresql.cnpg.io/v1/Cluster');
  for (const value of overrides) args.push('--set-json', value);
  return YAML.parseAllDocuments(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    .map(document => document.toJSON()).filter(Boolean);
}
const cnpg = ['database.mode="cnpg"'];
const find = (docs, kind, suffix = '') => docs.find(doc => doc.kind === kind && doc.metadata.name.endsWith(suffix));

test('CNPG is opt-in and requires its CRD', () => {
  assert.equal(find(render([], false), 'Cluster'), undefined);
  assert.throws(() => render(cnpg, false), error => error.stderr.toString().includes('requires the CloudNativePG operator'));
  assert.equal(find(render(['database.mode="external"', 'database.external.host="postgres.example.test"']), 'Cluster'), undefined);
});

test('CNPG owns storage and credentials while all Gateway jobs target its primary', () => {
  const docs = render(cnpg);
  const cluster = find(docs, 'Cluster');
  assert.equal(cluster.spec.instances, 3);
  assert.equal(cluster.metadata.annotations['helm.sh/resource-policy'], 'keep');
  assert.equal(cluster.spec.enableSuperuserAccess, false);
  assert.equal(find(docs, 'StatefulSet'), undefined);
  assert.equal(find(docs, 'Secret').stringData.DATABASE_URL, undefined);
  const workloads = [find(docs, 'Deployment'), find(docs, 'Job', '-migrate'), find(docs, 'Job', '-seed')];
  for (const workload of workloads) {
    const spec = workload.spec.template.spec;
    for (const container of [...(spec.initContainers ?? []), ...spec.containers]) {
      const env = Object.fromEntries(container.env.map(entry => [entry.name, entry]));
      assert.equal(env.DB_USER.valueFrom.secretKeyRef.name, `${cluster.metadata.name}-app`);
      assert.equal(env.DB_PASSWORD.valueFrom.secretKeyRef.key, 'password');
      assert.ok(env.DATABASE_URL.value.includes(`@${cluster.metadata.name}-rw:5432/${cluster.spec.bootstrap.initdb.database}?`));
    }
  }
});

test('CNPG storage, image, resources, scheduling and parameters can be configured', () => {
  const cluster = find(render([...cnpg,
    'database.cnpg.instances=5', 'database.cnpg.imageName="example.test/cnpg:17"',
    'database.cnpg.storageSize="50Gi"', 'database.cnpg.storageClassName="fast"',
    'database.cnpg.resources.requests.cpu="500m"', 'database.cnpg.resources.limits.memory="2Gi"',
    'database.cnpg.affinity.podAntiAffinityType="required"',
    'database.cnpg.affinity.nodeSelector={"workload":"database"}',
    'database.cnpg.affinity.tolerations=[{"key":"database","operator":"Exists","effect":"NoSchedule"}]',
    'database.cnpg.parameters={"max_connections":"100"}',
  ]), 'Cluster');
  assert.equal(cluster.spec.instances, 5);
  assert.equal(cluster.spec.imageName, 'example.test/cnpg:17');
  assert.deepEqual(cluster.spec.storage, { size: '50Gi', storageClass: 'fast' });
  assert.equal(cluster.spec.resources.requests.cpu, '500m');
  assert.equal(cluster.spec.resources.limits.memory, '2Gi');
  assert.equal(cluster.spec.affinity.podAntiAffinityType, 'required');
  assert.deepEqual(cluster.spec.affinity.nodeSelector, { workload: 'database' });
  assert.equal(cluster.spec.affinity.tolerations[0].effect, 'NoSchedule');
  assert.equal(cluster.spec.postgresql.parameters.max_connections, '100');
  assert.equal(find(render([...cnpg, 'database.cnpg.keepCluster=false']), 'Cluster').metadata.annotations, undefined);
});

test('invalid CNPG or migration wait settings fail schema validation', () => {
  for (const invalid of ['database.cnpg.instances=0', 'database.cnpg.affinity.podAntiAffinityType="invalid"',
    'database.cnpg.parameters={"max_connections":100}', 'database.waitForReadySeconds=0']) {
    assert.throws(() => render([...cnpg, invalid]), error => error.stderr.toString().includes('schema'));
  }
});

test('migration wait retries a temporarily unavailable database before proceeding', async () => {
  const job = find(render(cnpg), 'Job', '-migrate');
  const waiter = job.spec.template.spec.initContainers[0];
  assert.equal(waiter.name, 'wait-for-database');
  assert.equal(waiter.image, job.spec.template.spec.containers[0].image);
  let attempts = 0;
  let disconnected = false;
  let cleared = false;
  let deadline;
  const logs = [];
  await vm.runInNewContext(waiter.command[2], {
    require: () => ({ PrismaClient: class {
      async $queryRawUnsafe(query) {
        assert.equal(query, 'SELECT 1');
        if (++attempts < 3) throw new Error('unavailable');
      }
      async $disconnect() { disconnected = true; }
    } }),
    setTimeout: (callback, ms) => {
      if (ms === 600000) { deadline = callback; return 1; }
      callback();
    },
    clearTimeout: id => { assert.equal(id, 1); cleared = true; },
    console: { log: message => logs.push(message), error: message => logs.push(message) },
    process: { exit: () => { throw new Error('unexpected exit'); } },
  });
  assert.equal(attempts, 3);
  assert.ok(disconnected && cleared);
  assert.equal(typeof deadline, 'function');
  assert.deepEqual(logs, ['Database is ready for migrations.']);
});

test('migration wait exits on deadline without printing connection details', () => {
  const waiter = find(render(['database.waitForReadySeconds=2']), 'Job', '-migrate').spec.template.spec.initContainers[0];
  let deadline;
  let exitCode;
  const errors = [];
  vm.runInNewContext(waiter.command[2], {
    require: () => ({ PrismaClient: class {
      $queryRawUnsafe() { return new Promise(() => {}); }
    } }),
    setTimeout: (callback, ms) => { assert.equal(ms, 2000); deadline = callback; },
    console: { error: message => errors.push(message) },
    process: { exit: code => { exitCode = code; } },
  });
  deadline();
  assert.equal(exitCode, 1);
  assert.deepEqual(errors, ['Database readiness timed out before migrations.']);
});
