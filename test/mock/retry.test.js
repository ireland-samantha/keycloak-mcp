import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeWorkflow, startScenario } from '../support/scenario.js';
import { createStep, readRealm } from '../support/steps.js';

const groupCreate = createStep('groups', 'group-id', { name: 'retry-group' });
const failure = status => ({ status, json: { error: `HTTP ${status}` } });

test('C1 a GET rejected with 401 refreshes the token once and replays', async t => {
  const { mock, mcp } = await startScenario(t);
  await mcp.call('keycloak_read', readRealm);
  mock.revokeTokens();
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.value.status, 200);
  assert.equal(result.value.attempts, 2);
  assert.equal(mock.tokenRequests().length, 2);
  assert.deepEqual(mock.adminRequests().map(request => request.headers.authorization),
    ['Bearer mock-access-token-1', 'Bearer mock-access-token-1', 'Bearer mock-access-token-2']);
});

test('C2 a second 401 is reported after two attempts', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('GET /admin/realms/{realm}', mock.fixture('admin.unauthorized'));
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Keycloak operation failed (HTTP 401; attempts 2)');
  assert.equal(mock.tokenRequests().length, 2);
});

test('C3 the converter POST is a read but a 401 there is not replayed', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('POST /admin/realms/{realm}/client-description-converter', mock.fixture('admin.unauthorized'));
  const result = await mcp.call('keycloak_read', { operation: 'POST /admin/realms/{realm}/client-description-converter',
    args: { contentType: 'text/plain', body: '{"clientId":"converted"}' } });
  assert.equal(result.text, 'Keycloak operation failed (HTTP 401; attempts 1)');
  assert.equal(mock.tokenRequests().length, 1);
  assert.equal(mock.adminRequests().length, 1);
});

test('C4 a workflow mutation rejected with 401 is sent once and reported IN_DOUBT', async t => {
  const { mock, result } = await executeWorkflow(t, [groupCreate], {
    program: mock => mock.on('POST /admin/realms/{realm}/groups', mock.fixture('admin.unauthorized')) });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.equal(mock.adminRequests().filter(request => request.method === 'POST').length, 1);
});

test('D1 reads retry 502, 503 and 504 up to three attempts, about 150 ms then 400 ms apart', async t => {
  for (const status of [502, 503, 504]) await t.test(`HTTP ${status}`, async t => {
    const { mock, mcp } = await startScenario(t);
    mock.on('GET /admin/realms/{realm}', failure(status), failure(status), mock.fixture('realm.get'));
    const result = await mcp.call('keycloak_read', readRealm);
    assert.equal(result.value.attempts, 3);
    const [first, second, third] = mock.adminRequests().map(request => request.receivedAt);
    assert.ok(second - first >= 140, `first retry after ${second - first} ms`);
    assert.ok(third - second >= 390, `second retry after ${third - second} ms`);
  });
  await t.test('exhausted', async t => {
    const { mock, mcp } = await startScenario(t);
    mock.on('GET /admin/realms/{realm}', failure(503));
    const result = await mcp.call('keycloak_read', readRealm);
    assert.equal(result.text, 'Keycloak operation failed (HTTP 503; attempts 3)');
  });
});

test('D2 HTTP 500 is not retried', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('GET /admin/realms/{realm}', failure(500));
  assert.equal((await mcp.call('keycloak_read', readRealm)).text, 'Keycloak operation failed (HTTP 500; attempts 1)');
  assert.equal(mock.adminRequests().length, 1);
});

test('D3 a 503 on a mutation step is sent once and may have committed', async t => {
  const { mock, result } = await executeWorkflow(t, [groupCreate], { program: mock => mock.on('POST /admin/realms/{realm}/groups', failure(503)) });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.equal(result.error, 'Keycloak operation failed (HTTP 503; attempts 1)');
  assert.deepEqual(mock.adminRequests().map(request => request.method), ['POST']);
});

test('D4 attempts is reported only when a read needed more than one', async t => {
  const { mcp } = await startScenario(t);
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.value.status, 200);
  assert.equal('attempts' in result.value, false);
});
