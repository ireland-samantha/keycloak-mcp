import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KeycloakAdmin, configFromEnv } from '../src/keycloak.js';
import { runWorkflow } from '../src/workflow.js';

if (process.env.KEYCLOAK_MCP_LIVE_SOAK !== 'true') throw new Error('set KEYCLOAK_MCP_LIVE_SOAK=true to run against a disposable Keycloak realm');
const credentials = JSON.parse(readFileSync(process.env.KEYCLOAK_MCP_SOAK_CREDENTIALS, 'utf8'));
if (!credentials.realm?.startsWith('keycloak-mcp-soak-')) throw new Error('refusing non-disposable realm');
const env = {
  KEYCLOAK_BASE_URL: process.env.KEYCLOAK_BASE_URL,
  KEYCLOAK_REALM: credentials.realm,
  KEYCLOAK_AUTH_REALM: credentials.authRealm,
  KEYCLOAK_CLIENT_ID: credentials.clientId,
  KEYCLOAK_CLIENT_SECRET: credentials.clientSecret,
  KEYCLOAK_MCP_ALLOW_WRITE: 'true',
  KEYCLOAK_MCP_SINGLE_WRITER: 'true',
  KEYCLOAK_MCP_JOURNAL_DIR: process.env.KEYCLOAK_MCP_JOURNAL_DIR,
  KEYCLOAK_MCP_CATALOG_VERSION: process.env.KEYCLOAK_MCP_CATALOG_VERSION || 'latest',
};
const admin = new KeycloakAdmin(configFromEnv(env));
const realmKey = 'GET /admin/realms/{realm}';
const updateKey = 'PUT /admin/realms/{realm}';
const before = await admin.invoke(realmKey);
assert.equal(before.value.realm, credentials.realm);
const original = before.value.displayName ?? '';
const originalUserCount = (await admin.invoke('GET /admin/realms/{realm}/users/count')).value;
const clients = await admin.invoke('GET /admin/realms/{realm}/clients', { query: { clientId: 'keycloak-mcp-soak' } });
const client = clients.value.find(item => item.clientId === 'keycloak-mcp-soak');
assert.ok(client?.id);
const secret = await admin.invoke('GET /admin/realms/{realm}/clients/{client-uuid}/client-secret', { path: { 'client-uuid': client.id } });
assert.equal(secret.value, '[REDACTED: sensitive endpoint]');

let rollbackCycles = 0;
let successCycles = 0;
let locationCompensationCycles = 0;
for (let i = 0; i < 20; i += 1) {
  const changed = `soak-rollback-${i}`;
  const result = await runWorkflow(admin, [
    { operation: updateKey, args: { body: { displayName: changed } }, compensate: { operation: updateKey, args: { body: { displayName: original } } } },
    { operation: 'POST /admin/realms/{realm}/users', args: { body: {} }, compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT', JSON.stringify(result));
  assert.equal(result.priorStepsCompensated, true);
  assert.equal((await admin.invoke(realmKey)).value.displayName ?? '', original);
  assert.equal((await admin.invoke('GET /admin/realms/{realm}/users/count')).value, originalUserCount);
  rollbackCycles += 1;
}
for (let i = 0; i < 10; i += 1) {
  const changed = `soak-success-${i}`;
  const result = await runWorkflow(admin, [
    { operation: updateKey, args: { body: { displayName: changed } }, compensate: { operation: updateKey, args: { body: { displayName: original } } } },
    { operation: updateKey, args: { body: { displayName: original } }, compensate: { operation: updateKey, args: { body: { displayName: changed } } } },
  ], { dryRun: false });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal((await admin.invoke(realmKey)).value.displayName ?? '', original);
  successCycles += 1;
}
for (let i = 0; i < 10; i += 1) {
  const result = await runWorkflow(admin, [
    { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: `soak-location-${i}`, enabled: false } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } },
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: {} },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT', JSON.stringify(result));
  assert.equal(result.priorStepsCompensated, true);
  assert.equal(result.rollback[0].status, 204);
  assert.equal((await admin.invoke('GET /admin/realms/{realm}/users/count')).value, originalUserCount);
  locationCompensationCycles += 1;
}
console.log(JSON.stringify({ realm: credentials.realm, read: 'passed', secretRedaction: 'passed', rollbackCycles, successCycles, locationCompensationCycles, finalDisplayNameRestored: true, finalUserCountUnchanged: true }));
