import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeOperation } from '../../src/api.js';
import { readResult } from '../../src/http/response.js';
import { redactResponse } from '../../src/policy/redaction.js';
import { FIELD_REDACTIONS } from '../../src/policy/table.js';
import { testConfig } from '../support/config.js';

const MARKER = '[REDACTED by keycloak-mcp]';
const realmOp = { path: '/admin/realms/{realm}' };
const redact = (value, op = realmOp) => redactResponse(value, op);

test('secret fields are redacted where Keycloak representations carry them, keeping their JSON type', () => {
  const client = { clientId: 'app', secret: 's1', registrationAccessToken: 'eyJ.x.y',
    attributes: { 'client.secret.rotated': 's0', 'saml.signing.private.key': 'k', 'jwt.credential.private.key': 'k', 'access.token.lifespan': '120' } };
  assert.deepEqual(redact(client), { clientId: 'app', secret: MARKER, registrationAccessToken: MARKER,
    attributes: { 'client.secret.rotated': MARKER, 'saml.signing.private.key': MARKER, 'jwt.credential.private.key': MARKER, 'access.token.lifespan': '120' } });
  const component = { providerId: 'ldap', config: { bindCredential: ['p'], bindDn: ['cn=admin'], privateKey: ['a', 'b'], enabled: ['true'] } };
  assert.deepEqual(redact(component).config, { bindCredential: [MARKER], bindDn: ['cn=admin'], privateKey: [MARKER, MARKER], enabled: ['true'] });
  assert.deepEqual(redact({ smtpServer: { password: 'p', authTokenClientSecret: 'c', user: 'mailer' } }).smtpServer,
    { password: MARKER, authTokenClientSecret: MARKER, user: 'mailer' });
  assert.deepEqual(redact({ alias: 'idp', config: { clientSecret: 'c', clientId: 'broker' } }).config, { clientSecret: MARKER, clientId: 'broker' });
  assert.deepEqual(redact({ credentials: [{ type: 'password', value: 'v', secretData: 'd', credentialData: '{}' }] }).credentials,
    [{ type: 'password', value: MARKER, secretData: MARKER, credentialData: '{}' }]);
});

test('names that are secrets only in one place stay visible everywhere else', () => {
  const settings = { password: 'Password', value: 42, clientSecret: 'label', attributes: { password: ['x'] }, access: { resetPassword: true },
    accessTokenLifespan: 300, revokeRefreshToken: false, requiredCredentials: ['password'], authorizationServicesEnabled: true };
  assert.equal(redact(settings), settings);
  const configProperty = { name: 'bindCredential', type: 'Password', secret: true };
  assert.equal(redact({ properties: [configProperty] }).properties[0], configProperty, 'a boolean secret flag is not a secret');
});

test('Keycloak\'s own mask and vault references are left as sent', () => {
  const masked = { secret: '**********', smtpServer: { password: '${vault.smtp}' }, config: { bindCredential: ['**********'] } };
  assert.equal(redact(masked), masked);
});

test('private JSON Web Key members are redacted in JSON and in JSON text, public members kept', () => {
  const rsa = { kty: 'RSA', kid: 'k1', n: 'modulus', e: 'AQAB', d: 'private', p: 'p', q: 'q', dp: 'dp', dq: 'dq', qi: 'qi' };
  assert.deepEqual(redact({ keys: [rsa, { kty: 'oct', k: 'shared' }] }).keys,
    [{ kty: 'RSA', kid: 'k1', n: 'modulus', e: 'AQAB', d: MARKER, p: MARKER, q: MARKER, dp: MARKER, dq: MARKER, qi: MARKER }, { kty: 'oct', k: MARKER }]);
  const attribute = JSON.stringify({ keys: [rsa] });
  assert.deepEqual(JSON.parse(redact({ attributes: { 'jwks.string': attribute } }).attributes['jwks.string']).keys[0].d, MARKER);
  const publicOnly = `{ "keys": [ { "kty": "RSA", "n": "modulus", "e": "AQAB" } ] }`;
  assert.equal(redact({ attributes: { 'jwks.string': publicOnly } }).attributes['jwks.string'], publicOnly, 'kept byte for byte');
});

test('a PEM private key is redacted whatever field holds it', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n';
  assert.deepEqual(redact({ attributes: { 'tls.key': pem, 'tls.cert': '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----' } }).attributes,
    { 'tls.key': MARKER, 'tls.cert': '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----' });
});

test('admin-event representations are withheld whole', () => {
  const events = [{ operationType: 'CREATE', representation: '{"clientId":"app"}' }];
  assert.deepEqual(redactResponse(events, { path: '/admin/realms/{realm}/admin-events' }), [{ operationType: 'CREATE', representation: MARKER }]);
});

// Responses recorded from Keycloak HEAD, in which every planted secret Keycloak returns in clear reads
// <scrubbed-secret> or <scrubbed-jwt> (test/mock/fixtures/README.md).
const recorded = JSON.parse(readFileSync(new URL('../mock/fixtures/keycloak-head.json', import.meta.url), 'utf8')).responses;
const isPlanted = text => text.includes('<scrubbed-secret>') || text.includes('<scrubbed-jwt>') || /PRIVATE KEY-----/.test(text);

function leaves(value, path = []) {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, [...path, index]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
  return [[path.join('/'), value]];
}

// Each successful JSON response of a catalog operation, read as keycloak_read reads it.
async function recordedReads(settings = {}) {
  const reads = [];
  for (const [name, { operation, status, headers, body }] of Object.entries(recorded)) {
    if (status >= 300 || body === null || typeof body === 'string') continue;
    let op;
    try { op = describeOperation(operation); } catch { continue; }
    const response = new Response(JSON.stringify(body), { status, headers });
    reads.push({ name, op, body, result: await readResult(response, { op, config: testConfig(settings) }) });
  }
  return reads;
}

const withheldWhole = (op, path) => (FIELD_REDACTIONS[op.path]?.fields ?? []).includes(path.split('/').at(-1));

test('recorded HEAD representations lose nothing but their planted secrets', async () => {
  const reads = await recordedReads();
  assert.ok(reads.some(read => read.name === 'components.list') && reads.some(read => read.name === 'realm.get'));
  for (const { name, op, body, result } of reads) {
    if (typeof result.value === 'string') continue; // a sensitive endpoint, withheld whole
    const before = new Map(leaves(body));
    for (const [path, value] of leaves(result.value)) {
      if (before.get(path) === value || withheldWhole(op, path)) continue;
      assert.ok(typeof before.get(path) === 'string' && isPlanted(before.get(path)), `${name} ${path} changed from ${JSON.stringify(before.get(path))}`);
    }
  }
});

// Keycloak writes keys as base64 DER without the PEM header and footer (BCPemUtilsProvider.java:48-60).
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const headerless = (key, type) => key.export({ type, format: 'der' }).toString('base64');
const recordedCertificate = recorded['components.list'].body.find(component => component.name === 'fixture-imported-rsa').config.certificate[0];

test('the private key of an uploaded keystore is redacted; its certificate and public key are not', async () => {
  // CertificateInfoHelper.java:303-305 returns the keystore's private key next to its certificate.
  const op = describeOperation('POST /admin/realms/{realm}/identity-provider/upload-certificate');
  const uploaded = { privateKey: headerless(keyPair.privateKey, 'pkcs1'), publicKey: headerless(keyPair.publicKey, 'spki'), certificate: recordedCertificate };
  const response = new Response(JSON.stringify(uploaded), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.deepEqual((await readResult(response, { op, config: testConfig() })).value, { ...uploaded, privateKey: MARKER });
});

async function survivingSecrets(settings) {
  const survivors = [];
  for (const { name, result } of await recordedReads(settings)) {
    for (const [path, value] of leaves(result.value)) if (typeof value === 'string' && isPlanted(value)) survivors.push(`${name} ${path}`);
  }
  return survivors;
}

test('no planted secret that Keycloak returns in clear survives a read once the operator names custom secret attributes', async () => {
  assert.deepEqual(await survivingSecrets({ KEYCLOAK_MCP_SECRET_ATTRIBUTES: 'customApiKey, custom.api.key' }), []);
  // Attributes a deployment invents are not in Keycloak's model; nothing but their name marks them as secret.
  assert.deepEqual(await survivingSecrets(), ['realm.get attributes/customApiKey', 'client.registrationAccessToken attributes/custom.api.key',
    'clients.list 0/attributes/custom.api.key', 'client.get attributes/custom.api.key']);
});

test('operator-named secret keys are redacted in attribute and config maps only', () => {
  const value = { customApiKey: 'visible', attributes: { customApiKey: ['k'], other: ['v'] }, config: { customApiKey: ['k'] } };
  assert.deepEqual(redactResponse(value, realmOp, ['customApiKey']),
    { customApiKey: 'visible', attributes: { customApiKey: [MARKER], other: ['v'] }, config: { customApiKey: [MARKER] } });
});
