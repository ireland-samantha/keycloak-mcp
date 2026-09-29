import assert from 'node:assert/strict';
import { existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeWorkflow, receipts, startScenario, WRITER } from '../support/scenario.js';
import { createStep, missingUser, realmUpdate } from '../support/steps.js';

const userId = '0d9f4b4e-3c52-4f7a-9d55-0c7f1a2b3c01';
const groupId = '0d9f4b4e-3c52-4f7a-9d55-0c7f1a2b3c02';
const userCreate = createStep('users', 'user-id', { username: 'saga-user' });
const groupCreate = createStep('groups', 'group-id', { name: 'saga-group' });
const serverError = { status: 500, json: { error: 'unknown_error' } };
const writes = mock => mock.adminRequests().filter(request => request.method !== 'GET').map(request => request.key);
const modeOf = path => statSync(path).mode & 0o777;

test('H1 without execute the workflow is only preflighted: no request, no receipt', async t => {
  const { mock, mcp, journalDir } = await startScenario(t, { settings: WRITER });
  const result = await mcp.call('keycloak_workflow', { steps: [realmUpdate, userCreate] });
  assert.deepEqual(result.value, { status: 'PREFLIGHT_OK', steps: [
    { operation: 'PUT /admin/realms/{realm}', compensation: 'PUT /admin/realms/{realm}' },
    { operation: 'POST /admin/realms/{realm}/users', compensation: 'DELETE /admin/realms/{realm}/users/{user-id}' },
  ] });
  assert.deepEqual(mock.requests, []);
  assert.equal(existsSync(journalDir), false);
});

test('H2 execute:true completes and leaves a 0600 receipt named by the runId in a 0700 directory', async t => {
  const { result, journalDir } = await executeWorkflow(t, [realmUpdate, groupCreate], { transport: 'stdio' });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.completed, [{ operation: 'PUT /admin/realms/{realm}', status: 204 },
    { operation: 'POST /admin/realms/{realm}/groups', status: 201 }]);
  const [receipt] = receipts(journalDir);
  assert.equal(receipt.file, `${result.runId}.json`);
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(modeOf(journalDir), 0o700);
  assert.equal(modeOf(join(journalDir, receipt.file)), 0o600);
});

test('H2 a completed create reports the resource it created', { todo: 'MCPLIVE-12' }, async t => {
  const { text } = await executeWorkflow(t, [groupCreate], {
    program: mock => mock.on('POST /admin/realms/{realm}/groups', mock.created(`${mock.realmPath}/groups/${groupId}`)) });
  assert.ok(text.includes(groupId), text);
});

test('I1 completed steps are compensated in reverse order after a failed mutation', async t => {
  const { mock, result } = await executeWorkflow(t, [realmUpdate, userCreate, groupCreate], { program: mock => mock
    .on('POST /admin/realms/{realm}/users', mock.created(`${mock.realmPath}/users/${userId}`))
    .on('POST /admin/realms/{realm}/groups', serverError) });
  assert.deepEqual(writes(mock), [`PUT ${mock.realmPath}`, `POST ${mock.realmPath}/users`, `POST ${mock.realmPath}/groups`,
    `DELETE ${mock.realmPath}/users/${userId}`, `PUT ${mock.realmPath}`]);
  assert.deepEqual(mock.adminRequests().at(-1).json(), { displayName: 'original' });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.equal(result.priorStepsCompensated, true);
  assert.deepEqual(result.rollback, [
    { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', path: { 'user-id': userId }, status: 204, outcome: 'COMPENSATED' },
    { operation: 'PUT /admin/realms/{realm}', path: {}, status: 204, outcome: 'COMPENSATED' },
  ]);
});

test('I2 a failed read does not claim the failed step may have committed', async t => {
  const { result } = await executeWorkflow(t, [groupCreate, missingUser]);
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, false);
  assert.equal(result.priorStepsCompensated, true);
});

test('I3 a failed compensation is reported and prior steps are not claimed compensated', async t => {
  const { result } = await executeWorkflow(t, [realmUpdate, groupCreate], { program: mock => mock
    .on('PUT /admin/realms/{realm}', { status: 204 }, serverError)
    .on('POST /admin/realms/{realm}/groups', serverError) });
  assert.deepEqual(result.rollback, [{ operation: 'PUT /admin/realms/{realm}', path: {}, outcome: 'FAILED',
    error: 'Keycloak operation failed (HTTP 500; attempts 1)' }]);
  assert.equal(result.priorStepsCompensated, false);
});

test('I4 an irreversible step that completed before the failure is not rolled back', async t => {
  const { mock, result } = await executeWorkflow(t, [{ operation: 'DELETE /admin/realms/{realm}/groups/{group-id}',
    args: { path: { 'group-id': groupId } }, irreversible: true }, missingUser], { settings: { ...WRITER, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' } });
  assert.deepEqual(result.rollback, []);
  assert.equal(result.priorStepsCompensated, false);
  assert.deepEqual(writes(mock), [`DELETE ${mock.realmPath}/groups/${groupId}`]);
});

test('I5 compensating a realm create uses a token minted after the realm existed', async t => {
  const { mock, result } = await executeWorkflow(t, [{ operation: 'POST /admin/realms', args: { body: { realm: 'test-realm' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}' } }, missingUser], {
    settings: { ...WRITER, KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' },
    // Admin checks read the client roles carried in the token (services/.../fgap/MgmtPermissions.java:167-179);
    // only a token minted after the create holds the new realm's admin roles.
    program: mock => mock.on('DELETE /admin/realms/{realm}', request => request.headers.authorization === 'Bearer mock-access-token-2'
      ? { status: 204 } : { status: 403, json: { error: 'HTTP 403 Forbidden' } }) });
  assert.deepEqual(result.rollback, [{ operation: 'DELETE /admin/realms/{realm}', path: {}, status: 204, outcome: 'COMPENSATED' }]);
  assert.equal(mock.tokenRequests().length, 2);
});

test('I6 an unwritable journal does not stop the rollback', { todo: 'WF-03' }, async t => {
  const { mock } = await executeWorkflow(t, [groupCreate, missingUser], { program: (mock, { journalDir }) =>
    mock.on('POST /admin/realms/{realm}/groups', () => {
      renameSync(journalDir, `${journalDir}.moved`);
      writeFileSync(journalDir, 'not a directory');
      return mock.created(`${mock.realmPath}/groups/${groupId}`);
    }) });
  assert.ok(writes(mock).includes(`DELETE ${mock.realmPath}/groups/${groupId}`), 'created group was not deleted');
});

test('I7 rollback never deletes an authorization scope that existed before the workflow', { todo: 'WF-01' }, async t => {
  const existing = '638458b3-ebfc-4494-8864-d0f0f3b52421';
  const scopes = 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope';
  const { mock } = await executeWorkflow(t, [{ operation: scopes, args: { path: { 'client-uuid': 'client-1' }, body: { name: 'fixture-scope' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope/{scope-id}',
      args: { path: { 'client-uuid': 'client-1', 'scope-id': '$step.responseId' } } } }, missingUser], {
    // ScopeService.create answers 201 with the existing scope when the name is taken
    // (services/.../authorization/admin/ScopeService.java:97, RepresentationToModel.java:1789-1806).
    program: mock => mock.on(scopes, mock.fixture('authz.scope.createExisting')) });
  assert.equal(writes(mock).some(key => key.endsWith(`/scope/${existing}`) && key.startsWith('DELETE')), false);
});
