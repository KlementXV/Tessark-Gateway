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

test('private mirror rewrites every workload and propagates pull secrets to jobs', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const docs = render([
    'global.imageRegistry="registry.internal:5000"',
    'global.imageRepositoryPrefix="platform"',
    'global.imagePullSecrets=["mirror"]',
    'image.repository="ghcr.io/tessark/gateway"',
    `image.digest="${hash}"`,
    'imagePullSecrets=[{"name":"app"},{"name":"mirror"}]',
    'database.embedded.image="docker.io/library/postgres:17-alpine"',
    'database.embedded.imagePullSecrets=["database"]',
    'skopeo.imagePullSecrets=["transfer"]',
    `builds.runnerImage="ghcr.io/tessark/runner@${hash}"`,
    'builds.imagePullSecrets=[{"name":"builder"}]',
  ]);
  for (const workload of docs.filter(doc => ['Deployment', 'Job', 'Pod'].includes(doc.kind))) {
    const pod = workload.kind === 'Pod' ? workload.spec : workload.spec.template.spec;
    assert.deepEqual(pod.imagePullSecrets, [{ name: 'mirror' }, { name: 'app' }]);
    for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
      assert.equal(container.image, `registry.internal:5000/platform/tessark/gateway@${hash}`);
    }
  }
  const postgres = find(docs, 'StatefulSet').spec.template.spec;
  assert.equal(postgres.containers[0].image, 'registry.internal:5000/platform/library/postgres:17-alpine');
  assert.deepEqual(postgres.imagePullSecrets, [{ name: 'mirror' }, { name: 'database' }]);
  const env = find(docs, 'ConfigMap').data;
  assert.equal(env.SKOPEO_IMAGE, 'registry.internal:5000/platform/skopeo/stable:latest');
  assert.equal(env.SKOPEO_IMAGE_PULL_SECRETS, 'mirror,transfer');
  assert.equal(env.BUILDS_RUNNER_IMAGE, `registry.internal:5000/platform/tessark/runner@${hash}`);
  assert.deepEqual(JSON.parse(env.BUILDS_IMAGE_PULL_SECRETS), [{ name: 'mirror' }, { name: 'builder' }]);
});

test('CNPG private image and secrets are configurable while an omitted image stays operator-owned', () => {
  const settings = [...cnpg, 'global.imageRegistry="mirror.internal"', 'global.imagePullSecrets=["mirror"]',
    'database.cnpg.imagePullSecrets=["database"]'];
  const cluster = find(render([...settings, 'database.cnpg.imageName="ghcr.io/cloudnative-pg/postgresql:17"']), 'Cluster');
  assert.equal(cluster.spec.imageName, 'mirror.internal/cloudnative-pg/postgresql:17');
  assert.deepEqual(cluster.spec.imagePullSecrets, [{ name: 'mirror' }, { name: 'database' }]);
  assert.equal(find(render(settings), 'Cluster').spec.imageName, undefined);
});

test('component-only configuration and legacy app pull secrets remain supported', () => {
  const docs = render(['image.registry="private.internal"', 'image.repository="custom/gateway"',
    'image.tag="release"', 'imagePullSecrets=[{"name":"app"}]',
    'database.embedded.image="private.internal/custom/postgres:17"']);
  assert.equal(find(docs, 'Deployment').spec.template.spec.containers[0].image, 'private.internal/custom/gateway:release');
  assert.deepEqual(find(docs, 'Pod').spec.imagePullSecrets, [{ name: 'app' }]);
  assert.equal(find(docs, 'StatefulSet').spec.template.spec.containers[0].image, 'private.internal/custom/postgres:17');
});

test('invalid image registry, digest and secret shapes fail before deployment', () => {
  for (const invalid of ['global.imageRegistry="https://registry.internal"',
    'global.imageRepositoryPrefix="mirror"', 'image.digest="sha256:bad"',
    'global.imagePullSecrets=[{"name":"wrong-shape"}]', 'database.cnpg.imagePullSecrets=[1]']) {
    assert.throws(() => render([invalid]), error => error.stderr.toString().includes('schema'));
  }
});

test('ClusterIP defaults and custom listener keep service, probes and PORT aligned', () => {
  const docs = render(['service.port=8080', 'service.targetPort=4000', 'service.clusterIP="10.96.0.50"',
    'service.annotations={"example.test/network":"internal"}']);
  const service = docs.find(doc => doc.kind === 'Service' && !doc.metadata.name.endsWith('-postgres'));
  assert.equal(service.spec.type, 'ClusterIP');
  assert.equal(service.spec.clusterIP, '10.96.0.50');
  assert.equal(service.spec.ports[0].port, 8080);
  assert.equal(service.spec.ports[0].targetPort, 'http');
  assert.equal(service.spec.ports[0].nodePort, undefined);
  assert.equal(service.metadata.annotations['example.test/network'], 'internal');
  const app = find(docs, 'Deployment').spec.template.spec.containers[0];
  assert.equal(app.ports[0].containerPort, 4000);
  assert.equal(app.env.find(item => item.name === 'PORT').value, '4000');
  assert.equal(app.readinessProbe.httpGet.port, 'http');
  assert.equal(find(docs, 'Ingress'), undefined);
});

test('NodePort and LoadBalancer support fixed or allocated node ports', () => {
  for (const type of ['NodePort', 'LoadBalancer']) {
    for (const port of [0, 30080]) {
      const docs = render([`service.type="${type}"`, `service.nodePort=${port}`, 'service.externalTrafficPolicy="Local"']);
      const service = docs.find(doc => doc.kind === 'Service' && !doc.metadata.name.endsWith('-postgres'));
      assert.equal(service.spec.type, type);
      assert.equal(service.spec.ports[0].nodePort, port || undefined);
      assert.equal(service.spec.externalTrafficPolicy, 'Local');
    }
  }
});

test('Ingress routes through the configured ClusterIP port with class and TLS', () => {
  const docs = render(['ingress.enabled=true', 'ingress.ingressClassName="traefik"',
    'ingress.annotations={"example.test/ingress":"enabled"}', 'service.port=8080',
    'ingress.hosts=[{"host":"gateway.internal","paths":[{"path":"/","pathType":"Prefix"}]}]',
    'ingress.tls=[{"secretName":"gateway-tls","hosts":["gateway.internal"]}]']);
  const ingress = find(docs, 'Ingress');
  assert.equal(ingress.spec.ingressClassName, 'traefik');
  assert.equal(ingress.spec.tls[0].secretName, 'gateway-tls');
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.port.number, 8080);
  assert.equal(find(docs, 'ConfigMap').data.AUTH_URL, 'https://gateway.internal');
});

test('invalid service combinations and empty enabled Ingress fail validation', () => {
  for (const invalid of [['service.nodePort=30080'], ['service.externalTrafficPolicy="Local"'],
    ['service.targetPort=80'], ['service.type="NodePort"', 'service.nodePort=65536'],
    ['ingress.enabled=true', 'ingress.hosts=[]']]) {
    assert.throws(() => render(invalid), error => error.stderr.toString().includes('schema'));
  }
});
