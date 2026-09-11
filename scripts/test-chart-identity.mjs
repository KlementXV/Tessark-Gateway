// Embedded Dex in the chart (docs/plan-ldap-sso-local.md, lot 6), rendered without a cluster.
// Run with: node --test scripts/test-chart-identity.mjs  (needs helm on PATH)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const chart = 'deploy/helm/tessark-gateway';

function render(overrides = []) {
  const args = ['template', 'gateway-test', chart, '--namespace', 'gateway-test'];
  for (const value of overrides) args.push('--set-json', value);
  return YAML.parseAllDocuments(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    .map(document => document.toJSON()).filter(Boolean);
}

function renderError(overrides) {
  try {
    render(overrides);
    return null;
  } catch (error) {
    return error.stderr.toString();
  }
}

const ldap = {
  type: 'ldap', id: 'ad', name: 'Directory',
  config: { host: 'dc.example.test:636', bindDN: 'cn=svc,dc=example,dc=test', bindPW: '$LDAP_BIND_PW',
    userSearch: { baseDN: 'ou=people,dc=example,dc=test', username: 'uid', idAttr: 'uid', emailAttr: 'mail', nameAttr: 'cn', preferredUsernameAttr: 'uid' } },
};
const upstream = {
  type: 'oidc', id: 'partners', name: 'Partners',
  config: { issuer: 'https://login.partner.test', clientID: '$PARTNER_ID', clientSecret: '$PARTNER_SECRET', redirectURI: 'https://gateway.example.test/dex/callback' },
};
const sso = (connectors, extra = []) => [
  'auth.url="https://gateway.example.test"', 'oidc.enabled=true', `identity.dex.connectors=${JSON.stringify(connectors)}`, ...extra,
];
const identityObjects = docs => docs.filter(doc => doc.metadata?.labels?.['app.kubernetes.io/component'] === 'identity');
const gatewayConfig = docs => docs.find(doc => doc.kind === 'ConfigMap' && doc.data?.OIDC_ENABLED !== undefined).data;
const dexConfig = docs => YAML.parse(docs.find(doc => doc.kind === 'ConfigMap' && doc.data?.['config.yaml']).data['config.yaml']);
const deployment = (docs, component) => docs.find(doc => doc.kind === 'Deployment' && (doc.metadata.labels['app.kubernetes.io/component'] === 'identity') === (component === 'identity'));

test('a default install deploys no identity component', () => {
  const docs = render();
  assert.deepEqual(identityObjects(docs), []);
  assert.equal(gatewayConfig(docs).OIDC_ENABLED, 'false');
});

test('LDAP only, OIDC only and mixed all deploy Dex, wired to the Gateway', () => {
  for (const connectors of [[ldap], [upstream], [ldap, upstream]]) {
    const docs = render(sso(connectors));
    const kinds = identityObjects(docs).map(doc => doc.kind).sort();
    assert.deepEqual(kinds, ['ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'Deployment', 'Role', 'RoleBinding', 'Secret', 'Service', 'ServiceAccount']);

    const config = gatewayConfig(docs);
    assert.equal(config.OIDC_ISSUER, 'https://gateway.example.test/dex');
    assert.equal(config.OIDC_CLIENT_ID, 'tessark-gateway');

    const dex = dexConfig(docs);
    assert.equal(dex.issuer, 'https://gateway.example.test/dex');
    assert.deepEqual(dex.storage, { type: 'kubernetes', config: { inCluster: true } });
    assert.equal(dex.enablePasswordDB, false);
    assert.deepEqual(dex.staticClients[0].redirectURIs, ['https://gateway.example.test/api/auth/callback/oidc']);
    assert.deepEqual(dex.connectors.map(connector => connector.type), connectors.map(connector => connector.type));

    // One client secret, in Dex's Secret; the Gateway reads that very key rather than a copy.
    const env = Object.fromEntries(deployment(docs, 'gateway').spec.template.spec.containers[0].env.map(entry => [entry.name, entry]));
    const dexSecret = identityObjects(docs).find(doc => doc.kind === 'Secret');
    assert.deepEqual(env.OIDC_CLIENT_SECRET.valueFrom.secretKeyRef, { name: dexSecret.metadata.name, key: 'GATEWAY_CLIENT_SECRET' });
    assert.ok(dexSecret.stringData.GATEWAY_CLIENT_SECRET.length >= 32);
    const gatewaySecret = docs.find(doc => doc.kind === 'Secret' && doc.stringData?.AUTH_SECRET);
    assert.equal(gatewaySecret.stringData.OIDC_CLIENT_SECRET, undefined);
  }
});

test('Dex pods are never selected by the Gateway Service or Deployment', () => {
  const docs = render(sso([ldap]));
  const dexLabels = deployment(docs, 'identity').spec.template.metadata.labels;
  for (const selector of [
    docs.find(doc => doc.kind === 'Service' && doc.metadata.labels['app.kubernetes.io/component'] !== 'identity').spec.selector,
    deployment(docs, 'gateway').spec.selector.matchLabels,
  ]) {
    assert.ok(Object.entries(selector).some(([key, value]) => dexLabels[key] !== value), 'a Gateway selector matches Dex pods');
  }
});

test('global.imageRegistry rewrites the Dex image and pull secrets reach it', () => {
  const docs = render(sso([ldap], ['global.imageRegistry="registry.internal:5000"', 'global.imagePullSecrets=["registry-pull"]']));
  const spec = deployment(docs, 'identity').spec.template.spec;
  assert.equal(spec.containers[0].image, 'registry.internal:5000/dexidp/dex:v2.44.0');
  assert.deepEqual(spec.imagePullSecrets, [{ name: 'registry-pull' }]);
});

test('external mode deploys nothing and signs in through the operator\'s Dex', () => {
  const docs = render(['oidc.enabled=true', 'identity.mode="external"', 'oidc.issuer="https://sso.example.test"', 'oidc.clientId="gw"', 'oidc.clientSecret="s"']);
  assert.deepEqual(identityObjects(docs), []);
  assert.equal(gatewayConfig(docs).OIDC_ISSUER, 'https://sso.example.test');
  assert.equal(docs.find(doc => doc.kind === 'Secret' && doc.stringData?.AUTH_SECRET).stringData.OIDC_CLIENT_SECRET, 's');
});

test('the issuer rides the Gateway Ingress host, or gets an Ingress of its own', () => {
  const ingress = ['ingress.enabled=true', 'ingress.hosts=[{"host":"gateway.example.test","paths":[{"path":"/","pathType":"Prefix"}]}]'];
  const shared = render(['oidc.enabled=true', `identity.dex.connectors=${JSON.stringify([ldap])}`, ...ingress]);
  const paths = shared.find(doc => doc.kind === 'Ingress').spec.rules[0].http.paths;
  assert.equal(paths[0].path, '/dex');
  assert.match(paths[0].backend.service.name, /-dex$/);
  assert.equal(shared.filter(doc => doc.kind === 'Ingress').length, 1);

  const separate = render([...sso([ldap], ['identity.dex.issuer="https://sso.example.test"']), ...ingress]);
  const dexIngress = identityObjects(separate).find(doc => doc.kind === 'Ingress');
  assert.equal(dexIngress.spec.rules[0].host, 'sso.example.test');
  assert.equal(dexIngress.spec.rules[0].http.paths[0].path, '/');
});

test('configurations that would let nobody in fail the render', () => {
  assert.match(renderError(['auth.url="https://gateway.example.test"', 'oidc.enabled=true']), /at least one Dex connector/);
  assert.match(renderError(sso([{ type: 'saml', id: 'idp', name: 'IdP' }])), /saml connector is refused/);
  assert.match(renderError(sso([ldap], ['identity.dex.extraConfig={"staticPasswords":[]}'])), /static passwords/);
  assert.match(renderError(sso([ldap], ['oidc.roleMapping={"admins":"ADMIN"}'])), /lacks "groups"/);
  assert.equal(renderError(sso([ldap], ['oidc.roleMapping={"admins":"ADMIN"}', 'oidc.scopes="openid profile email groups"'])), null);
  assert.match(renderError(['oidc.enabled=true', `identity.dex.connectors=${JSON.stringify([ldap])}`]), /needs auth.url/);
  assert.match(renderError(sso([ldap], ['oidc.issuer="https://elsewhere.test"'])), /derived from the embedded Dex/);
  // Refused by values.schema.json before the template's own message can run; either says issuer.
  assert.match(renderError(['oidc.enabled=true', 'identity.mode="external"']), /needs oidc\.issuer|\/oidc\/issuer/);
});
