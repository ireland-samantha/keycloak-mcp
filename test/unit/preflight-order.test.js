import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflight } from '../../src/workflow/preflight.js';
import { testConfig } from '../support/config.js';

const writer = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
const override = { ...writer, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' };
const readRealm = 'GET /admin/realms/{realm}';
const createGroup = 'POST /admin/realms/{realm}/groups';
const deleteGroup = 'DELETE /admin/realms/{realm}/groups/{group-id}';

// Each plan breaks two rules; the message shows which one preflight applies first.
const cases = [
  ['step count before write permission', {}, Array(21).fill({ operation: createGroup }), 'workflow requires 1 to 20 steps'],
  ['every step\'s shape before write permission', {}, [{ operation: createGroup }, { args: {} }], 'step 2 has no operation'],
  ['realm creation before request validation', { ...writer, KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' },
    [{ operation: 'POST /admin/realms', args: { body: { realm: 'other' }, query: { unknown: 1 } } }], 'step 1 realm creation must name the configured realm'],
  ['request validation before the read-only checks', {}, [{ operation: readRealm, args: { query: { unknown: 1 } }, irreversible: true }],
    'unknown query parameter: unknown'],
  ['irreversible mark before compensation on a read', {}, [{ operation: readRealm, irreversible: true, compensate: { operation: readRealm } }],
    'step 1 is read-only and cannot be marked irreversible'],
  ['irreversible override before the compensation rules', writer, [{ operation: deleteGroup, args: { path: { 'group-id': 'g' } },
    compensate: { operation: readRealm } }], 'step 1 is irreversible and requires an explicit override'],
  ['create-needs-delete before binding target', writer, [{ operation: createGroup, args: { body: {} },
    compensate: { operation: 'PUT /admin/realms/{realm}', args: { path: { 'group-id': '$step.locationId' } } } }], 'step 1 compensation must delete the created resource'],
  ['same-resource update before irreversible compensation', writer, [{ operation: 'PUT /admin/realms/{realm}', args: { body: {} },
    compensate: { operation: 'DELETE /admin/realms/{realm}' } }], 'step 1 update compensation must target the same resource'],
  ['irreversible compensation before compensation request validation', writer, [{ operation: 'POST /admin/realms/{realm}/roles', args: { body: { name: 'new' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/roles/{role-name}', args: { path: { 'role-name': 'old' }, query: { unknown: 1 } } } }],
  'step 1 cannot use an irreversible compensation without a generated-ID or matching created-name binding'],
  ['compensation request validation before must-mutate', override, [{ operation: deleteGroup, args: { path: { 'group-id': 'g' } }, irreversible: true,
    compensate: { operation: readRealm, args: { query: { unknown: 1 } } } }], 'unknown query parameter: unknown'],
  ['compensation rules before the write lock', { KEYCLOAK_MCP_ALLOW_WRITE: 'true' }, [{ operation: createGroup, args: { body: {} },
    compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: {} } } }], 'step 1 compensation must delete the created resource'],
];

for (const [name, settings, steps, message] of cases) {
  test(`preflight order: ${name}`, () => {
    assert.throws(() => preflight(testConfig(settings), steps), { message });
  });
}
