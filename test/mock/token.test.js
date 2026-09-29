import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScenario, WRITER } from '../support/scenario.js';
import { readRealm } from '../support/steps.js';

test('B1 the first call exchanges client credentials with HTTP Basic and a client_credentials form', async t => {
  const { mock, mcp } = await startScenario(t);
  assert.equal((await mcp.call('keycloak_read', readRealm)).isError, false);
  const [token] = mock.tokenRequests();
  assert.equal(token.key, 'POST /realms/master/protocol/openid-connect/token');
  assert.equal(token.headers.authorization, `Basic ${Buffer.from(`${mock.clientId}:${mock.clientSecret}`).toString('base64')}`);
  assert.equal(token.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([...token.form()], [['grant_type', 'client_credentials']]);
  assert.equal(mock.adminRequests()[0].headers.authorization, 'Bearer mock-access-token-1');
});

test('B1 credentials with reserved characters authenticate as Keycloak decodes them', { todo: 'BC-03' }, async t => {
  const { mcp } = await startScenario(t, { mock: { clientId: 'urn:bc03:reader', clientSecret: 'p+s%41ss:w rd' } });
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.isError, false, result.text);
});

test('B2 reads reuse one cached token', async t => {
  const { mock, mcp } = await startScenario(t);
  for (let read = 0; read < 3; read += 1) await mcp.call('keycloak_read', readRealm);
  assert.equal(mock.tokenRequests().length, 1);
  assert.equal(mock.adminRequests().length, 3);
});

test('B3 a token expiring within the 30 s skew is fetched again for every call', async t => {
  const { mock, mcp } = await startScenario(t, { mock: { expiresIn: 30 } });
  for (let read = 0; read < 3; read += 1) await mcp.call('keycloak_read', readRealm);
  assert.equal(mock.tokenRequests().length, 3);
});

test('B4 token endpoint failures are specific errors that never echo the secret', async t => {
  const cases = [
    ['rejected credentials', mock => mock.fixture('token.invalidClient'), /token request failed \(HTTP 401\)$/],
    ['invalid JSON', () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"access_token":' }), /token response is invalid JSON$/],
    ['incomplete token', () => ({ json: { token_type: 'Bearer', expires_in: 300 } }), /token response is incomplete$/],
    ['token over 64 KiB', () => ({ json: { access_token: 'x'.repeat(65 * 1024), expires_in: 300 } }), /^response exceeds configured limit \(HTTP 200\)$/],
  ];
  for (const [name, respond, message] of cases) await t.test(name, async t => {
    const { mock, mcp } = await startScenario(t);
    mock.onToken((request, keycloak) => respond(keycloak));
    const result = await mcp.call('keycloak_read', readRealm);
    assert.equal(result.isError, true);
    assert.match(result.text, message);
    assert.equal(result.text.includes(mock.clientSecret), false);
    assert.equal(mock.adminRequests().length, 0);
  });
});

test('B5 KEYCLOAK_AUTH_REALM selects the realm that issues the token', async t => {
  const { mock, mcp } = await startScenario(t, { transport: 'stdio', mock: { authRealm: 'service-accounts' } });
  assert.equal((await mcp.call('keycloak_read', readRealm)).isError, false);
  assert.deepEqual(mock.tokenRequests().map(request => request.path), ['/realms/service-accounts/protocol/openid-connect/token']);
});

test('B6 logout-all drops the cached token, so the next call fetches a new one', async t => {
  const { mock, mcp } = await startScenario(t, { settings: { ...WRITER, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' } });
  const logout = await mcp.call('keycloak_workflow', { execute: true,
    steps: [{ operation: 'POST /admin/realms/{realm}/logout-all', irreversible: true }] });
  assert.equal(logout.value.status, 'COMPLETED');
  await mcp.call('keycloak_read', readRealm);
  assert.equal(mock.tokenRequests().length, 2);
  assert.deepEqual(mock.adminRequests().map(request => request.headers.authorization), ['Bearer mock-access-token-1', 'Bearer mock-access-token-2']);
});

test('B7 concurrent calls on a cold cache share one token grant', { todo: 'BC-09' }, async t => {
  const { mock, mcp } = await startScenario(t);
  await Promise.all(Array.from({ length: 5 }, () => mcp.call('keycloak_read', readRealm)));
  assert.equal(mock.tokenRequests().length, 1);
});
