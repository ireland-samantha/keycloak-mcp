import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertRefusedOffline, startScenario, WRITER } from '../support/scenario.js';

const canary = 'redaction-canary-4b1f';
const SENSITIVE_READS = { KEYCLOAK_MCP_ALLOW_SENSITIVE_READS: 'true' };
const withSecret = (response, secret = canary) => ({ ...response, json: response.json.map(item => ({ ...item, secret })) });
const clientPath = { path: { 'client-uuid': 'client-1' } };

test('E1 the default scrub replaces sensitive keys at any depth, in objects and arrays', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('GET /admin/realms/{realm}/clients', withSecret(mock.fixture('clients.list')));
  const clients = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/clients' });
  assert.deepEqual(clients.value.value.map(client => client.secret), ['[REDACTED by keycloak-mcp]']);
  assert.equal(clients.text.includes(canary), false);
  const realm = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}' });
  assert.equal(realm.value.value.smtpServer.password, '[REDACTED by keycloak-mcp]');
  assert.equal(realm.value.value.smtpServer.host, 'smtp.example.invalid');
});

test('E1 non-secret realm settings are returned exactly as Keycloak sent them', { todo: 'BC-02' }, async t => {
  const { mock, mcp } = await startScenario(t);
  const { smtpServer: _masked, ...expected } = mock.fixture('realm.get').json;
  const { smtpServer: _redacted, ...actual } = (await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}' })).value.value;
  assert.deepEqual(actual, expected);
});

test('E2 admin-event representations are redacted, the event itself is not', async t => {
  const { mock, mcp } = await startScenario(t);
  const events = (await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/admin-events' })).value.value;
  const recorded = mock.fixture('adminEvents.list').json;
  assert.deepEqual(events.map(event => event.representation), recorded.map(() => '[REDACTED by keycloak-mcp]'));
  assert.deepEqual(events.map(event => event.resourcePath), recorded.map(event => event.resourcePath));
});

// Each: operation, arguments, and an optional response replacing the recorded one (JSON, text or binary).
const sensitiveEndpoints = [
  ['GET /admin/realms/{realm}/clients/{client-uuid}/client-secret', clientPath, { json: { type: 'secret', value: canary } }],
  ['GET /admin/realms/{realm}/clients-initial-access', {}],
  ['GET /admin/realms/{realm}/users/{user-id}/credentials', { path: { 'user-id': 'user-1' } }],
  ['GET /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}', { path: { 'client-uuid': 'client-1', attr: 'jwt.credential' } },
    { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(canary) }],
  ['GET /admin/realms/{realm}/clients/{client-uuid}/installation/providers/{providerId}',
    { path: { 'client-uuid': 'client-1', providerId: 'keycloak-oidc-keycloak-json' } }],
  ['GET /admin/realms/{realm}/clients/{client-uuid}/installation/providers/{providerId}',
    { path: { 'client-uuid': 'client-1', providerId: 'keycloak-oidc-jboss-subsystem' } }],
  ['GET /admin/realms/{realm}/clients/{client-uuid}/evaluate-scopes/generate-example-access-token', clientPath],
];

async function readSensitive(t, settings) {
  const { mock, mcp } = await startScenario(t, { settings });
  const results = [];
  for (const [operation, args, response] of sensitiveEndpoints) {
    if (response) mock.on(operation, response);
    results.push({ operation, providerId: args.path?.providerId, result: await mcp.call('keycloak_read', { operation, args }) });
  }
  return results;
}

test('E3 sensitive endpoints return only a marker for JSON, text and binary bodies', async t => {
  for (const { operation, providerId, result } of await readSensitive(t)) {
    assert.equal(result.value.status, 200);
    assert.equal(result.value.value, '[REDACTED by keycloak-mcp: sensitive endpoint]', `${operation} ${providerId ?? ''}`);
  }
});

test('E3 a certificate download is readable as an export and still redacted', { todo: 'classification: certificate download is read-only' }, async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/download',
    { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(canary) });
  const result = await mcp.call('keycloak_read', { operation: 'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/download',
    args: { path: { 'client-uuid': 'client-1', attr: 'jwt.credential' }, body: { format: 'JKS', keyAlias: 'a', keyPassword: 'b', storePassword: 'c' } } });
  assert.deepEqual(result.value, { status: 200, contentType: 'application/octet-stream', value: '[REDACTED by keycloak-mcp: sensitive endpoint]' });
});

test('E4 KEYCLOAK_MCP_ALLOW_SENSITIVE_READS passes sensitive bodies through', async t => {
  const results = await readSensitive(t, SENSITIVE_READS);
  for (const { operation, providerId, result } of results) {
    assert.equal(result.isError, false, operation);
    assert.notEqual(result.value.value, '[REDACTED by keycloak-mcp: sensitive endpoint]', `${operation} ${providerId ?? ''}`);
  }
  const valueOf = suffix => results.find(({ operation }) => operation.endsWith(suffix)).result.value.value;
  assert.deepEqual(valueOf('/client-secret'), { type: 'secret', value: canary });
  assert.deepEqual(valueOf('/certificates/{attr}'), { base64: Buffer.from(canary).toString('base64'), contentType: 'application/octet-stream' });
  const { mcp } = await startScenario(t, { settings: SENSITIVE_READS });
  const events = (await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/admin-events' })).value.value;
  assert.ok(events.every(event => event.representation.startsWith('{')));
});

test('E5 neither the client secret nor a bearer token appears in any output, stderr line or receipt', async t => {
  const secret = 'e5-service-account-secret-canary';
  const { mock, mcp, server, journalDir } = await startScenario(t, { transport: 'stdio', settings: WRITER, mock: { clientSecret: secret } });
  mock.on('GET /admin/realms/{realm}/clients', withSecret(mock.fixture('clients.list')));
  const outputs = [
    await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/clients' }),
    await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/clients/{client-uuid}/client-secret', args: clientPath }),
    await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } }),
    await mcp.call('keycloak_workflow', { execute: true, steps: [
      { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'e5-group' } },
        compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
      { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } },
    ] }),
  ].map(result => result.text);
  await server.close();
  const journal = readdirSync(journalDir).map(file => readFileSync(join(journalDir, file), 'utf8'));
  assert.equal(journal.length, 1);
  const issued = Array.from({ length: mock.tokenCount }, (_, index) => `mock-access-token-${index + 1}`);
  for (const text of [...outputs, server.stderr, ...journal]) {
    for (const needle of [secret, canary, ...issued]) assert.equal(text.includes(needle), false, `${needle} leaked`);
  }
});

test('E6 writing back a redacted read never sends the redaction marker to Keycloak', async t => {
  const { mock, mcp } = await startScenario(t, { settings: WRITER });
  const client = (await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/clients/{client-uuid}', args: clientPath })).value.value;
  const update = { operation: 'PUT /admin/realms/{realm}/clients/{client-uuid}', args: { ...clientPath, body: { ...client, description: 'updated' } },
    compensate: { operation: 'PUT /admin/realms/{realm}/clients/{client-uuid}', args: { ...clientPath, body: client } } };
  const refused = await mcp.call('keycloak_workflow', { execute: true, steps: [update] });
  // Keycloak stores the marker as the new client secret (RepresentationToModel.java:625-642, determineNewSecret).
  for (const request of mock.adminRequests()) assert.equal(request.text().includes('[REDACTED'), false, request.key);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^request contains a value redacted by keycloak-mcp/);
  assert.deepEqual(mock.adminRequests().map(request => request.method), ['GET']);
  // Leaving the redacted fields out, as the refusal asks, keeps the stored secret.
  const unredacted = Object.fromEntries(Object.entries(client).filter(([, value]) => value !== '[REDACTED by keycloak-mcp]'));
  const resent = await mcp.call('keycloak_workflow', { execute: true, steps: [{ ...update, args: { ...clientPath, body: { ...unredacted, description: 'updated' } },
    compensate: { ...update.compensate, args: { ...clientPath, body: unredacted } } }] });
  assert.equal(resent.value.status, 'COMPLETED', resent.text);
});

test('E6 the marker is refused in path, query and every body encoding before any request', async t => {
  const { mock, mcp } = await startScenario(t, { settings: WRITER });
  const marker = '[REDACTED by keycloak-mcp]';
  const converter = 'POST /admin/realms/{realm}/client-description-converter';
  for (const args of [{ body: `{"secret":"${marker}"}` }, { contentType: 'application/json', body: { nested: [{ value: marker }] } },
    { contentType: 'application/json', bodyBase64: Buffer.from(`"${marker}"`).toString('base64') }]) {
    assertRefusedOffline(mock, await mcp.call('keycloak_read', { operation: converter, args }), /^request contains a value redacted by keycloak-mcp/);
  }
  assertRefusedOffline(mock, await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': marker } } }),
    /^request contains a value redacted by keycloak-mcp/);
  assertRefusedOffline(mock, await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/users', args: { query: { search: ['ok', `x${marker}`] } } }),
    /^request contains a value redacted by keycloak-mcp/);
  assertRefusedOffline(mock, await mcp.call('keycloak_read', { operation: 'POST /admin/realms/{realm}/identity-provider/upload-certificate',
    args: { body: { keystoreFormat: 'Certificate PEM', file: { filename: 'idp.pem', contentType: 'application/x-pem-file', base64: Buffer.from(marker).toString('base64') } } } }),
  /^request contains a value redacted by keycloak-mcp/);
});

test('E7 a JSON body with a mixed-case media type is still redacted', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('GET /admin/realms/{realm}/clients', { ...withSecret(mock.fixture('clients.list')), headers: { 'content-type': 'Application/JSON' } });
  const result = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/clients' });
  const decoded = result.value.value?.base64 ? Buffer.from(result.value.value.base64, 'base64').toString('utf8') : '';
  assert.equal(result.text.includes(canary) || decoded.includes(canary), false);
});
