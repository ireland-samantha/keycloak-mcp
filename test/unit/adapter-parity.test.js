import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import openclaw from '../../openclaw/index.js';
import { connectInProcess } from '../support/mcp-client.js';
import { startMockKeycloak } from '../support/mock-keycloak.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

// Both adapters serve the same Keycloak; each case is [tool, arguments]. Most cases are inputs that
// the adapters used to treat differently (TA-05, ARCH-4).
const cases = [
  ['keycloak_search_operations', {}],
  ['keycloak_search_operations', { search: 'users', method: 'get', offset: 2, limit: 3 }],
  ['keycloak_search_operations', { limit: -3 }],
  ['keycloak_search_operations', { limit: 1000 }],
  ['keycloak_search_operations', { offset: -5 }],
  ['keycloak_search_operations', { offset: '5' }],
  ['keycloak_search_operations', { search: 5 }],
  ['keycloak_describe_operation', { operation: 'GET /admin/realms/{realm}/users/{user-id}' }],
  ['keycloak_describe_operation', {}],
  ['keycloak_describe_schema', { name: 'ClientRepresentation' }],
  ['keycloak_describe_schema', { name: 'NoSuchRepresentation' }],
  ['keycloak_read', { operation: 'GET /admin/realms/{realm}' }],
  ['keycloak_read', { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': ['a', 'b'] } } }],
  ['keycloak_read', { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': { nested: true } } } }],
  ['keycloak_read', { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'blocked' } } }],
  ['keycloak_workflow', { steps: [{ operation: 'GET /admin/realms/{realm}' }] }],
  ['keycloak_workflow', { steps: [{ operation: 'GET /admin/realms/{realm}' }], execute: 'true' }],
  ['keycloak_workflow', { steps: [] }],
  ['keycloak_workflow', { steps: [{ operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': 'g' } }, irreversible: 'yes' }] }],
];

async function adapters(t) {
  const mock = await startMockKeycloak();
  t.after(() => mock.close());
  const settings = { KEYCLOAK_BASE_URL: mock.origin, KEYCLOAK_REALM: mock.realm, KEYCLOAK_CLIENT_ID: mock.clientId, KEYCLOAK_CLIENT_SECRET: mock.clientSecret };
  const mcp = await connectInProcess(settings);
  t.after(() => mcp.close());
  const openClawTools = new Map();
  const configPath = writePrivateJson(join(privateTempDir('keycloak-mcp-parity-'), 'config.json'), settings);
  openclaw.register({ pluginConfig: { configPath }, registerTool(definition) { openClawTools.set(definition.name, definition); } });
  return { mcp, openClawTools };
}

// A refusal or failure compares by its message, a success by its value.
const fromMcp = result => (result.isError ? { error: result.text } : { value: result.value });
const fromOpenClaw = result => (result.details?.ok === false ? { error: result.details.error } : { value: result.details });

test('both adapters advertise the same tools, descriptions and argument schemas', async t => {
  const { mcp, openClawTools } = await adapters(t);
  const mcpTools = await mcp.listTools();
  assert.deepEqual([...openClawTools.keys()], mcpTools.map(tool => tool.name));
  for (const { name, description, inputSchema: { $schema: _dialect, ...parameters } } of mcpTools) {
    assert.equal(openClawTools.get(name).description, description, name);
    assert.deepEqual(openClawTools.get(name).parameters, parameters, name);
  }
});

test('both adapters accept, refuse and answer the same arguments alike', async t => {
  const { mcp, openClawTools } = await adapters(t);
  for (const [tool, args] of cases) {
    const viaMcp = fromMcp(await mcp.call(tool, args));
    const viaOpenClaw = fromOpenClaw(await openClawTools.get(tool).execute('parity', args));
    assert.deepEqual(viaOpenClaw, viaMcp, `${tool} ${JSON.stringify(args)}`);
  }
});
