import { test } from 'node:test';
import { assertRefusedOffline, startScenario, WRITER } from '../support/scenario.js';
import { createStep, readRealm } from '../support/steps.js';

const IRREVERSIBLE = { ...WRITER, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' };
const user = { 'user-id': 'user-1' };
const groupCreate = createStep('groups', 'group-id', { name: 'gated' });
const groupDelete = { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': 'group-1' } } };
const sameResourceUpdate = (operation, path, body, before = {}) =>
  ({ operation, args: { path, body }, compensate: { operation, args: { path, body: before } } });
const workflow = (...steps) => ['keycloak_workflow', { execute: true, steps }];

const refusals = [
  ['G1 keycloak_read refuses a mutation', {}, ['keycloak_read', { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'x' } } }],
    /^mutations require a compensating workflow$/],
  ['G2 a workflow mutation needs KEYCLOAK_MCP_ALLOW_WRITE', {}, workflow(groupCreate), /^writes are disabled$/],
  ['G3 writes need a PostgreSQL lock or single-writer mode', { KEYCLOAK_MCP_ALLOW_WRITE: 'true' }, workflow(groupCreate),
    /^writes require a PostgreSQL lock or explicit single-writer mode$/],
  ['G4 creating a realm needs KEYCLOAK_MCP_ALLOW_REALM_ADMIN', WRITER, workflow({ operation: 'POST /admin/realms',
    args: { body: { realm: 'test-realm' } }, compensate: { operation: 'DELETE /admin/realms/{realm}' } }), /^realm administration is disabled$/],
  ['G5 an irreversible step needs the operator switch', WRITER, workflow({ ...groupDelete, irreversible: true }),
    /^step 1 is irreversible and requires an explicit override$/],
  ['G5 an irreversible step needs irreversible:true on the step', IRREVERSIBLE, workflow(groupDelete),
    /^step 1 is irreversible and requires an explicit override$/],
  ['G6 a read-only step cannot be marked irreversible', IRREVERSIBLE, workflow({ ...readRealm, irreversible: true }),
    /^step 1 is read-only and cannot be marked irreversible$/],
  ['G6 a read-only step cannot carry a compensation', WRITER, workflow({ ...readRealm,
    compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: {} } } }), /^step 1 is read-only and needs no compensation$/],
];

const unguardedHazards = [
  ['G7 a password set through the user representation needs the irreversible override', 'SEC-2', WRITER,
    workflow(sameResourceUpdate('PUT /admin/realms/{realm}/users/{user-id}', user,
      { credentials: [{ type: 'password', value: 'Chosen-Password-1', temporary: false }] })), /irreversible/],
  ['G7 a client secret set through the client representation needs the irreversible override', 'SEC-2', WRITER,
    workflow(sameResourceUpdate('PUT /admin/realms/{realm}/clients/{client-uuid}', { 'client-uuid': 'client-1' }, { secret: 'chosen-secret' })), /irreversible/],
  ['G8 test-nodes-available contacts registered nodes, so it is not a read', 'SEC-4', {},
    ['keycloak_read', { operation: 'GET /admin/realms/{realm}/clients/{client-uuid}/test-nodes-available', args: { path: { 'client-uuid': 'client-1' } } }],
    /compensating workflow/],
  ['G9 turning off event auditing needs the irreversible override', 'SEC-7', WRITER,
    workflow(sameResourceUpdate('PUT /admin/realms/{realm}/events/config', {}, { adminEventsEnabled: false, eventsEnabled: false },
      { adminEventsEnabled: true, eventsEnabled: true })), /irreversible/],
  ['G10 repointing a federation provider connection needs the irreversible override', 'SEC-3', WRITER,
    workflow(sameResourceUpdate('PUT /admin/realms/{realm}/components/{id}', { id: 'ldap-1' },
      { config: { connectionUrl: ['ldap://directory.example.invalid'] } })), /irreversible/],
];

async function refuses(t, settings, [tool, args], message) {
  const { mock, mcp } = await startScenario(t, { settings });
  assertRefusedOffline(mock, await mcp.call(tool, args), message);
}

for (const [name, settings, call, message] of refusals) test(name, t => refuses(t, settings, call, message));
for (const [name, todo, settings, call, message] of unguardedHazards) test(name, { todo }, t => refuses(t, settings, call, message));
