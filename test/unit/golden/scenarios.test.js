import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { KeycloakAdmin } from '../../../src/keycloak.js';
import { runWorkflow } from '../../../src/workflow.js';
import { testConfig } from '../../support/config.js';
import { fakeKeycloak, jsonResponse, routeTable, tokenResponse } from '../../support/fetch.js';
import { assertSnapshot } from '../../support/snapshot.js';
import { privateTempDir } from '../../support/temp.js';

const snapshot = new URL('snapshots/scenarios.json', import.meta.url);
const settings = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' };
const createdUser = 'https://id.example.com/auth/admin/realms/test-realm/users/u1';
const groupCompensation = { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } };
const realmUpdate = { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'n' } },
  compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'o' } } } };
const authzResource = 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource';

// Each scenario: routes the fake Keycloak answers ([pattern, response]) and the call under test.
const scenarios = {
  readRedact: [[['^GET ', () => jsonResponse(200, { a: 1, clientSecret: 'x', nested: [{ password: 'p' }] })]],
    admin => admin.invoke('GET /admin/realms/{realm}')],
  readText: [[['^GET ', () => new Response('hello', { headers: { 'content-type': 'text/plain' } })]],
    admin => admin.invoke('GET /admin/realms/{realm}/users/count')],
  readBinary: [[['^GET ', () => new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })]],
    admin => admin.invoke('GET /admin/realms/{realm}')],
  sensitive: [[['^GET ', () => jsonResponse(200, { value: 's' })]],
    admin => admin.invoke('GET /admin/realms/{realm}/clients/{client-uuid}/client-secret', { path: { 'client-uuid': 'x' } })],
  saga: [[
    ['^PUT ', () => jsonResponse(204, null)],
    ['^POST .*/users$', () => jsonResponse(201, null, { location: createdUser })],
    ['^POST .*/groups$', () => jsonResponse(500, {})],
    ['^DELETE ', () => jsonResponse(204, null)],
  ], admin => runWorkflow(admin, [
    realmUpdate,
    { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'u' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } },
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'g' } }, compensate: groupCompensation },
  ], { dryRun: false })],
  completed: [[['^PUT ', () => jsonResponse(204, null)], ['^GET ', () => jsonResponse(200, { realm: 'test-realm' })]],
    admin => runWorkflow(admin, [realmUpdate, { operation: 'GET /admin/realms/{realm}' }], { dryRun: false })],
  compFail: [[
    ['^POST ', () => jsonResponse(201, { _id: 'baebccda-a5cd-4ed8-a889-c95e4cf2d64b' })],
    ['^GET ', () => jsonResponse(404, {})],
    ['^DELETE ', () => jsonResponse(500, {})],
  ], admin => runWorkflow(admin, [
    { operation: authzResource, args: { path: { 'client-uuid': 'c1' }, body: { name: 'r' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource/{resource-id}',
        args: { path: { 'client-uuid': 'c1', 'resource-id': '$step.responseId' } } } },
    { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'm' } } },
  ], { dryRun: false })],
  dry: [[], admin => runWorkflow(admin, [{ operation: 'GET /admin/realms/{realm}' }])],
};

// Run IDs and receipt timestamps differ per run; generated v4 UUIDs are masked wherever they appear.
const mask = value => JSON.parse(JSON.stringify(value)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  .replace(/"at":"[^"]+"/g, '"at":"<t>"'));

async function observe(routes, call) {
  const journal = privateTempDir('keycloak-mcp-golden-');
  const admin = new KeycloakAdmin(testConfig({ ...settings, KEYCLOAK_MCP_JOURNAL_DIR: journal }),
    fakeKeycloak(routeTable(routes), { token: () => tokenResponse('t') }));
  let result;
  try { result = { ok: await call(admin) }; } catch (error) { result = { err: error.message }; }
  const receipts = readdirSync(journal).map(file => JSON.parse(readFileSync(join(journal, file), 'utf8')));
  return mask({ result, receipts });
}

test('reads and workflows return the results and journal receipts the golden master records', async () => {
  const golden = {};
  for (const [name, [routes, call]] of Object.entries(scenarios)) golden[name] = await observe(routes, call);
  assertSnapshot(snapshot, golden, { depth: 2 });
});
