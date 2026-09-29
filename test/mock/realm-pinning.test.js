import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertRefusedOffline, startScenario } from '../support/scenario.js';
import { readRealm } from '../support/steps.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

const readUser = id => ({ operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': id } } });

function extensionCatalog(operations) {
  return writePrivateJson(join(privateTempDir('keycloak-mcp-extension-'), 'extensions.json'), { source: 'mock provider', operations });
}

async function readRefused(mcp, mock, call, message) {
  assertRefusedOffline(mock, await mcp.call('keycloak_read', call), message);
}

test('F1 every request stays under the configured realm', async t => {
  const { mock, mcp } = await startScenario(t);
  for (const call of [
    readRealm,
    { operation: 'GET /admin/realms/{realm}/users', args: { query: { briefRepresentation: true } } },
    { operation: 'GET /admin/realms/{realm}/clients/{client-uuid}/client-secret', args: { path: { 'client-uuid': 'client-1' } } },
    readUser('user-1'),
  ]) await mcp.call('keycloak_read', call);
  assert.equal(mock.adminRequests().length, 4);
  for (const request of mock.adminRequests()) assert.ok(request.path.startsWith(mock.realmPath), request.path);
});

test('F2 another realm in args.path is refused before any request; the configured one is accepted', async t => {
  const { mock, mcp } = await startScenario(t);
  await readRefused(mcp, mock, { operation: 'GET /admin/realms/{realm}', args: { path: { realm: 'master' } } }, /^realm cannot be overridden$/);
  assert.equal((await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}', args: { path: { realm: mock.realm } } })).value.status, 200);
});

test('F3 dot segments are refused before any request', async t => {
  for (const value of ['..', '.']) await t.test(value, async t => {
    const { mock, mcp } = await startScenario(t);
    await readRefused(mcp, mock, readUser(value), /^unsafe path parameter: user-id$/);
  });
});

test('F3 group-by-path encodes each segment and refuses traversal', async t => {
  const { mock, mcp } = await startScenario(t);
  const operation = 'GET /admin/realms/{realm}/group-by-path/{path}';
  await mcp.call('keycloak_read', { operation, args: { path: { path: '/parent/child group' } } });
  assert.equal(mock.adminRequests()[0].path, `${mock.realmPath}/group-by-path/parent/child%20group`);
  const traversal = await mcp.call('keycloak_read', { operation, args: { path: { path: '/parent/../other' } } });
  assert.equal(traversal.text, 'unsafe group path');
  assert.equal(mock.adminRequests().length, 1);
});

test('F3 a name containing a slash or backslash is sent as one encoded segment', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('GET /admin/realms/{realm}/roles/{role-name}', { json: { name: 'role' } });
  for (const name of ['team/admin', 'back\\slash']) {
    const result = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/roles/{role-name}', args: { path: { 'role-name': name } } });
    assert.equal(result.isError, false, result.text);
  }
  assert.deepEqual(mock.adminRequests().map(request => request.path), [`${mock.realmPath}/roles/team%2Fadmin`, `${mock.realmPath}/roles/back%5Cslash`]);
});

test('F4 unknown path and query parameters are refused; query arrays repeat the parameter', async t => {
  const { mock, mcp } = await startScenario(t);
  await readRefused(mcp, mock, { operation: 'GET /admin/realms/{realm}', args: { path: { extra: 'x' } } }, /^unknown path parameter$/);
  await readRefused(mcp, mock, { operation: 'GET /admin/realms/{realm}/users', args: { query: { nope: 'x' } } }, /^unknown query parameter: nope$/);
  await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/users', args: { query: { briefRepresentation: true, search: ['alpha', 'beta'] } } });
  const [request] = mock.adminRequests();
  assert.deepEqual([...request.query], [['briefRepresentation', 'true'], ['search', 'alpha'], ['search', 'beta']]);
});

test('F4 an object-valued query parameter is refused instead of sent as [object Object]', async t => {
  const { mock, mcp } = await startScenario(t);
  const result = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/users', args: { query: { q: { dept: 'eng' } } } });
  assert.equal(result.isError, true, result.text);
  assert.deepEqual(mock.adminRequests(), []);
});

test('F5 SPI extension routes are pinned to the configured realm too', async t => {
  const catalog = extensionCatalog([{ method: 'GET', path: '/realms/{realm}/sample', readOnly: true, serviceAccountSupported: true, responseTypes: ['application/json'] }]);
  const { mock, mcp } = await startScenario(t, { settings: { KEYCLOAK_MCP_EXTENSION_CATALOG: catalog } });
  mock.on('GET /realms/{realm}/sample', { json: { sample: true } });
  assert.equal((await mcp.call('keycloak_read', { operation: 'GET /realms/{realm}/sample' })).value.status, 200);
  assert.deepEqual(mock.adminRequests().map(request => request.path), [`/realms/${mock.realm}/sample`]);
  const override = await mcp.call('keycloak_read', { operation: 'GET /realms/{realm}/sample', args: { path: { realm: 'master' } } });
  assert.equal(override.text, 'realm cannot be overridden');
});

test('F6 the realm list does not reveal other realms', { todo: 'SEC-5' }, async t => {
  const { mock, mcp } = await startScenario(t);
  const realm = mock.fixture('realm.get').json;
  mock.on('GET /admin/realms', { json: [realm, { ...realm, id: '00000000-0000-4000-8000-00000000f006', realm: 'other-realm' }] });
  const result = await mcp.call('keycloak_read', { operation: 'GET /admin/realms' });
  assert.equal(result.text.includes('other-realm'), false);
});

test('F7 an extension path hiding dot segments behind control characters cannot leave the realm', { todo: 'SEC-6' }, async t => {
  const operation = { method: 'GET', path: '/realms/{realm}/.\t./.\t./admin/realms/other-realm/users', readOnly: true, serviceAccountSupported: true };
  let scenario;
  try {
    scenario = await startScenario(t, { settings: { KEYCLOAK_MCP_EXTENSION_CATALOG: extensionCatalog([operation]) } });
  } catch (error) {
    assert.match(error.message, /invalid extension/);
    return;
  }
  await scenario.mcp.call('keycloak_read', { operation: `GET ${operation.path}` });
  for (const request of scenario.mock.adminRequests()) assert.ok(request.path.startsWith(`/realms/${scenario.mock.realm}/`), request.path);
});
