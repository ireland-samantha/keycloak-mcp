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

test('B1 credentials with reserved characters authenticate as Keycloak decodes them', async t => {
  const { mock, mcp } = await startScenario(t, { mock: { clientId: 'urn:bc03:reader', clientSecret: 'p+s%41ss:w rd/ü' } });
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.isError, false, result.text);
  const [token] = mock.tokenRequests();
  assert.equal(Buffer.from(token.headers.authorization.slice('Basic '.length), 'base64').toString('utf8'), 'urn%3Abc03%3Areader:p%2Bs%2541ss%3Aw+rd%2F%C3%BC');
});

test('B2 reads reuse one cached token', async t => {
  const { mock, mcp } = await startScenario(t);
  for (let read = 0; read < 3; read += 1) await mcp.call('keycloak_read', readRealm);
  assert.equal(mock.tokenRequests().length, 1);
  assert.equal(mock.adminRequests().length, 3);
});

test('B3 a short-lived token is reused for half its lifetime; one with no lifetime left is fetched for every call', async t => {
  for (const [expiresIn, grants] of [[30, 1], [0, 3]]) await t.test(`expires_in ${expiresIn}`, async t => {
    const { mock, mcp } = await startScenario(t, { mock: { expiresIn } });
    for (let read = 0; read < 3; read += 1) await mcp.call('keycloak_read', readRealm);
    assert.equal(mock.tokenRequests().length, grants);
  });
});

test('B4 token endpoint failures are specific errors that never echo the secret', async t => {
  const cases = [
    ['rejected credentials', mock => mock.fixture('token.invalidClient'), /token request failed \(HTTP 401\): unauthorized_client: Invalid client or Invalid client credentials$/],
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

test('B7 concurrent calls on a cold cache share one token grant', async t => {
  const { mock, mcp } = await startScenario(t);
  await Promise.all(Array.from({ length: 5 }, () => mcp.call('keycloak_read', readRealm)));
  assert.equal(mock.tokenRequests().length, 1);
});
