import { readFileSync, writeFileSync } from 'node:fs';
import { KeycloakAdmin, configFromEnv, isMutation } from '../src/keycloak.js';
import { runWorkflow } from '../src/workflow.js';

if (process.env.KEYCLOAK_MCP_LIVE_COVERAGE !== 'true') throw new Error('set KEYCLOAK_MCP_LIVE_COVERAGE=true');
const credentials = JSON.parse(readFileSync(process.env.KEYCLOAK_MCP_SOAK_CREDENTIALS, 'utf8'));
if (!credentials.realm?.startsWith('keycloak-mcp-soak-')) throw new Error('refusing non-disposable realm');
if (!process.env.KEYCLOAK_MCP_COVERAGE_OUT) throw new Error('KEYCLOAK_MCP_COVERAGE_OUT is required');

const withFixtures = process.env.KEYCLOAK_MCP_COVERAGE_FIXTURES === 'true';
const admin = new KeycloakAdmin(configFromEnv({
  KEYCLOAK_BASE_URL: process.env.KEYCLOAK_BASE_URL,
  KEYCLOAK_REALM: credentials.realm,
  KEYCLOAK_AUTH_REALM: credentials.authRealm,
  KEYCLOAK_CLIENT_ID: credentials.clientId,
  KEYCLOAK_CLIENT_SECRET: credentials.clientSecret,
  KEYCLOAK_MCP_CATALOG_VERSION: process.env.KEYCLOAK_MCP_CATALOG_VERSION || '26.3.5',
  KEYCLOAK_MCP_ALLOW_WRITE: withFixtures ? 'true' : 'false',
  KEYCLOAK_MCP_SINGLE_WRITER: withFixtures ? 'true' : 'false',
  KEYCLOAK_MCP_JOURNAL_DIR: process.env.KEYCLOAK_MCP_JOURNAL_DIR,
}));
let fixtures = null;
if (withFixtures) {
  const name = 'keycloak-mcp-fixture-group';
  const creation = await runWorkflow(admin, [{ operation: 'POST /admin/realms/{realm}/groups', args: { body: { name } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } }], { dryRun: false });
  if (creation.status !== 'COMPLETED') throw new Error(`group fixture creation ${creation.status}; inspect its receipt before cleanup`);
  const [clients, users, groups, scopes, roles] = await Promise.all([
    admin.invoke('GET /admin/realms/{realm}/clients', { query: { clientId: 'keycloak-mcp-soak' } }),
    admin.invoke('GET /admin/realms/{realm}/users', { query: { username: 'service-account-keycloak-mcp-soak', exact: true } }),
    admin.invoke('GET /admin/realms/{realm}/groups', { query: { search: name, exact: true } }),
    admin.invoke('GET /admin/realms/{realm}/client-scopes'),
    admin.invoke('GET /admin/realms/{realm}/roles'),
  ]);
  const client = clients.value.find(row => row.clientId === 'keycloak-mcp-soak');
  const user = users.value.find(row => row.username === 'service-account-keycloak-mcp-soak');
  const group = groups.value.find(row => row.name === name);
  const scope = scopes.value.find(row => row.name === 'profile') ?? scopes.value[0];
  const role = roles.value.find(row => row.name === 'uma_authorization') ?? roles.value[0];
  if (![client?.id, user?.id, group?.id, scope?.id, role?.id].every(Boolean)) throw new Error('fixture readback incomplete');
  fixtures = { 'client-uuid': client.id, 'client-id': client.id, client: client.id, clientUuid: client.id,
    'user-id': user.id, userId: user.id, 'group-id': group.id, 'client-scope-id': scope.id,
    'role-name': role.name, 'role-id': role.id, roleContainerId: client.id, path: `/${name}`, protocol: 'openid-connect', flowAlias: 'browser' };
}
const rows = [];
for (const op of admin.catalog.operations) {
  let state = '';
  let httpStatus = null;
  const names = [...op.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).filter(name => name !== 'realm');
  const path = {};
  for (const name of names) {
    if (fixtures?.[name]) path[name] = fixtures[name];
    else if (name === 'alias' && op.path.includes('/authentication/flows/')) path[name] = 'browser';
  }
  if (op.extension) state = 'NOT_RUN_EXTENSION';
  else if (isMutation(op.key, admin.catalog)) state = 'NOT_RUN_MUTATION';
  else if (!op.path.includes('{realm}')) state = 'NOT_RUN_GLOBAL_SCOPE';
  else if (names.some(name => !path[name])) state = 'NOT_RUN_PATH_FIXTURE';
  else if (op.parameters.some(p => p.in === 'query' && p.required)) state = 'NOT_RUN_QUERY_FIXTURE';
  else {
    try {
      const result = await admin.invoke(op.key, { path });
      state = 'OBSERVED_PASS';
      httpStatus = result.status;
    } catch (error) {
      state = 'OBSERVED_FAIL';
      const match = /HTTP (\d{3})/.exec(String(error.message));
      httpStatus = match ? Number(match[1]) : null;
    }
  }
  rows.push({ operation: op.key, state, httpStatus });
}
const counts = Object.fromEntries([...new Set(rows.map(row => row.state))].sort().map(state => [state, rows.filter(row => row.state === state).length]));
const report = { source: admin.catalog.source, sourceSha256: admin.catalog.sourceSha256, catalogVersion: admin.catalog.version, withFixtures,
  total: rows.length, counts, rows };
writeFileSync(process.env.KEYCLOAK_MCP_COVERAGE_OUT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ catalogVersion: report.catalogVersion, total: report.total, counts }));
