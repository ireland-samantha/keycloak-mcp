import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeycloakAdmin, preflight, runWorkflow, WorkflowBuilder } from '../../src/api.js';
import { testConfig } from '../support/config.js';
import { fakeKeycloak, jsonResponse, routeTable } from '../support/fetch.js';

const writer = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
const createdUser = 'https://id.example.com/auth/admin/realms/test-realm/users/new-user-id';
const userCreate = () => ({ operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'new-user' } },
  compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } });
const missingUser = { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } };

test('preflight returns a frozen copy that later changes to the caller\'s steps do not reach', () => {
  const steps = [userCreate()];
  const [planned] = preflight(testConfig(writer), steps);
  steps[0].args.body.username = 'changed';
  steps[0].compensate.args.path['user-id'] = 'pre-existing-user';
  assert.equal(planned.args.body.username, 'new-user');
  assert.equal(planned.compensate.args.path['user-id'], '$step.locationId');
  assert.ok(Object.isFrozen(planned) && Object.isFrozen(planned.args.body) && Object.isFrozen(planned.compensate.args.path));
});

test('preflight keeps numbers beyond 2^53 exact in its copy', () => {
  const [planned] = preflight(testConfig(writer), [{ operation: 'PUT /admin/realms/{realm}',
    args: { body: { attributes: { quota: JSON.rawJSON('9007199254740993') } } },
    compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: { attributes: { quota: 1 } } } } }]);
  assert.equal(JSON.stringify(planned.args.body), '{"attributes":{"quota":9007199254740993}}');
});

test('a workflow sends and compensates exactly what preflight validated, whatever the caller changes meanwhile', async () => {
  const sent = [];
  const admin = new KeycloakAdmin(testConfig(writer), fakeKeycloak(routeTable([
    ['^POST .*/users$', (url, options) => { sent.push(JSON.parse(options.body)); return jsonResponse(201, null, { location: createdUser }); }],
    ['^GET ', () => jsonResponse(404, {})],
    ['^DELETE ', url => { sent.push(new URL(url).pathname); return jsonResponse(204, null); }],
  ])));
  const steps = [userCreate(), missingUser];
  const run = runWorkflow(admin, steps, { dryRun: false });
  steps[0].args.body.username = 'changed';
  steps[0].compensate.args.path['user-id'] = 'pre-existing-user';
  const result = await run;
  assert.deepEqual(sent, [{ username: 'new-user' }, '/auth/admin/realms/test-realm/users/new-user-id']);
  assert.equal(result.rollback[0].path['user-id'], 'new-user-id');
});

test('WorkflowBuilder can mark a step irreversible, as runWorkflow steps can', async () => {
  const admin = new KeycloakAdmin(testConfig({ ...writer, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }));
  const remove = ['DELETE /admin/realms/{realm}/groups/{group-id}', { path: { 'group-id': 'g' } }];
  await assert.rejects(() => new WorkflowBuilder(admin).step(...remove).plan(), /irreversible and requires an explicit override/);
  assert.deepEqual(await new WorkflowBuilder(admin).step(...remove, null, { irreversible: true }).plan(),
    { status: 'PREFLIGHT_OK', steps: [{ operation: remove[0], compensation: null }] });
});

test('a step stopped before its request is sent is not reported as possibly committed', async () => {
  const admin = new KeycloakAdmin(testConfig(writer), fakeKeycloak(() => jsonResponse(201, null, { location: createdUser }),
    { token: () => jsonResponse(503, { error: 'temporarily_unavailable' }) }));
  const result = await runWorkflow(admin, [userCreate()], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.match(result.error, /token request failed \(HTTP 503\)/);
  assert.equal(result.failedStepMayHaveCommitted, false);
});

test('every preflight rule, the write gate included, sees the same copy of a step', () => {
  let reads = 0;
  const step = { args: {}, get operation() { reads += 1; return reads === 1 ? 'GET /admin/realms/{realm}' : 'PUT /admin/realms/{realm}'; } };
  assert.deepEqual(preflight(testConfig(), [step]).map(planned => planned.operation), ['GET /admin/realms/{realm}']);
  assert.equal(reads, 1);
});
