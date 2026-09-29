import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertRefusedOffline, receipts, startScenario, WRITER } from '../support/scenario.js';
import { createStep, missingUser, realmUpdate } from '../support/steps.js';
import { privateTempDir } from '../support/temp.js';

const groupCreate = createStep('groups', 'group-id', { name: 'journal-group' });

// Records the receipt as it stands when each request reaches Keycloak, then answers as the mock would.
function watchReceipts(mock, journalDir, routes) {
  const seen = [];
  for (const [route, response] of routes) mock.on(route, (request, keycloak) => {
    const [receipt] = receipts(journalDir);
    seen.push({ request: request.method, status: receipt.status, next: receipt.next, failedOperation: receipt.failedOperation,
      completed: receipt.completed.map(item => item.operation) });
    return response(keycloak);
  });
  return seen;
}

test('L1 a completed run moves the receipt from STEP_IN_FLIGHT to COMPLETED', async t => {
  const { mock, mcp, journalDir } = await startScenario(t, { settings: WRITER });
  const seen = watchReceipts(mock, journalDir, [['PUT /admin/realms/{realm}', () => ({ status: 204 })],
    ['POST /admin/realms/{realm}/groups', keycloak => keycloak.created(`${keycloak.realmPath}/groups/l1`)]]);
  const result = await mcp.call('keycloak_workflow', { execute: true, steps: [realmUpdate, groupCreate] });
  assert.deepEqual(seen, [
    { request: 'PUT', status: 'STEP_IN_FLIGHT', next: realmUpdate.operation, failedOperation: undefined, completed: [] },
    { request: 'POST', status: 'STEP_IN_FLIGHT', next: groupCreate.operation, failedOperation: undefined, completed: [realmUpdate.operation] },
  ]);
  const [receipt] = receipts(journalDir);
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(receipt.runId, result.value.runId);
  assert.deepEqual(receipt.completed.map(item => item.operation), [realmUpdate.operation, groupCreate.operation]);
});

test('L1 a failed run records COMPENSATING before the rollback and ends IN_DOUBT', async t => {
  const { mock, mcp, journalDir } = await startScenario(t, { settings: WRITER });
  const seen = watchReceipts(mock, journalDir, [
    ['POST /admin/realms/{realm}/groups', keycloak => keycloak.created(`${keycloak.realmPath}/groups/l1`)],
    ['GET /admin/realms/{realm}/users/{user-id}', keycloak => keycloak.fixture('user.notFound')],
    ['DELETE /admin/realms/{realm}/groups/{group-id}', () => ({ status: 204 })],
  ]);
  await mcp.call('keycloak_workflow', { execute: true, steps: [groupCreate, missingUser] });
  assert.deepEqual(seen.map(({ request, status, failedOperation }) => [request, status, failedOperation]), [
    ['POST', 'STEP_IN_FLIGHT', undefined], ['GET', 'STEP_IN_FLIGHT', undefined], ['DELETE', 'COMPENSATING', missingUser.operation]]);
  const [receipt] = receipts(journalDir);
  assert.equal(receipt.status, 'IN_DOUBT');
  assert.deepEqual(receipt.rollback, [{ operation: groupCreate.compensate.operation, path: { 'group-id': 'l1' }, status: 204, outcome: 'COMPENSATED' }]);
});

test('L2 receipts record paths only, never request bodies', async t => {
  const canary = 'L2-Canary-Password-1';
  const { mcp, journalDir } = await startScenario(t, { settings: WRITER });
  const result = await mcp.call('keycloak_workflow', { execute: true,
    steps: [createStep('users', 'user-id', { username: 'l2-user', credentials: [{ type: 'password', value: canary }] })] });
  assert.equal(result.value.status, 'COMPLETED');
  const text = readFileSync(join(journalDir, `${result.value.runId}.json`), 'utf8');
  assert.equal(text.includes(canary), false);
  assert.equal(text.includes('l2-user'), false);
});

test('L3 credential IDs in paths are redacted in receipts', async t => {
  const { mcp, journalDir } = await startScenario(t, { settings: { ...WRITER, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' } });
  const path = { 'user-id': 'user-1', credentialId: 'credential-canary-1', newPreviousCredentialId: 'credential-canary-2' };
  const result = await mcp.call('keycloak_workflow', { execute: true, steps: [{ irreversible: true, args: { path },
    operation: 'POST /admin/realms/{realm}/users/{user-id}/credentials/{credentialId}/moveAfter/{newPreviousCredentialId}' }] });
  const [receipt] = receipts(journalDir);
  assert.equal(receipt.runId, result.value.runId);
  assert.deepEqual(receipt.plan[0].path, { 'user-id': 'user-1', credentialId: '[REDACTED by keycloak-mcp]', newPreviousCredentialId: '[REDACTED by keycloak-mcp]' });
  assert.equal(JSON.stringify(receipt).includes('credential-canary'), false);
});

test('L4 a group-readable journal directory is refused before any request', async t => {
  const { mock, mcp, journalDir } = await startScenario(t, { settings: WRITER });
  mkdirSync(journalDir);
  chmodSync(journalDir, 0o755);
  assertRefusedOffline(mock, await mcp.call('keycloak_workflow', { execute: true, steps: [groupCreate] }),
    /^journal directory must be private \(mode 0700\)$/);
});

test('L5 a journal directory that cannot be created is refused before any request', async t => {
  const blocker = join(privateTempDir('keycloak-mcp-blocker-'), 'not-a-directory');
  writeFileSync(blocker, '');
  const { mock, mcp } = await startScenario(t, { settings: { ...WRITER, KEYCLOAK_MCP_JOURNAL_DIR: join(blocker, 'journal') } });
  assertRefusedOffline(mock, await mcp.call('keycloak_workflow', { execute: true, steps: [groupCreate] }), /ENOTDIR/);
});
