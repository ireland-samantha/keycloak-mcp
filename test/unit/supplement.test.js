import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCatalog, describeOperation, describeSchema, listOperations, preflight } from '../../src/api.js';
import { openApiCatalog } from '../../src/catalog/index.js';
import { withSupplement } from '../../src/catalog/supplement.js';
import { buildRequest } from '../../src/http/request.js';
import { readResult } from '../../src/http/response.js';
import { isIrreversible, isMutation, isSensitiveEndpoint } from '../../src/policy/classify.js';
import { testConfig } from '../support/config.js';

// Seven operations of the supplement the Java module generated (wip/java 92e4716), in its exact format,
// with three of its schemas shortened.
const fixture = JSON.parse(readFileSync(new URL('fixtures/admin-client-supplement.json', import.meta.url), 'utf8'));
const openApiOnly = () => openApiCatalog('nightly');
const catalog = withSupplement(openApiOnly(), fixture);
const ROLE_POLICIES = 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/role';
const SYNC = 'POST /admin/realms/{realm}/user-storage/{componentId}/sync';
const REFRESH = 'PUT /admin/realms/{realm}/users/{user-id}/vc/credentials/{credentialScopeName}';
const GRANT = 'POST /admin/realms/{realm}/users/{user-id}/vc/credentials';
const GRANTS = 'GET /admin/realms/{realm}/users/{user-id}/vc/credentials';
const withOperations = operations => ({ ...fixture, operations });
const variant = (key, changes) => withOperations([{ ...fixture.operations.find(op => op.key === key), ...changes }]);

test('the supplement adds its operations to the catalog with their origin and provenance', () => {
  const base = openApiOnly();
  const merged = withSupplement(base, fixture);
  assert.equal(merged.operations.length, base.operations.length + fixture.operations.length);
  assert.deepEqual(merged.operations.map(op => op.key), [...merged.operations.map(op => op.key)].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(merged.operations.filter(op => op.origin === 'admin-client').map(op => op.key), fixture.operations.map(op => op.key));
  assert.ok(merged.operations.every(op => ['openapi', 'admin-client'].includes(op.origin)));
  assert.equal(merged.sourceSha256, base.sourceSha256);
  assert.match(merged.source, /openapi\.json; org\.keycloak:keycloak-admin-client:999\.0\.0-SNAPSHOT \(999\.0\.0-20260928\.023246-474\)$/);
  const { schemas: _schemas, ...provenance } = merged.supplement;
  assert.deepEqual(provenance, { source: fixture.source, resolvedVersion: fixture.resolvedVersion, sourceSha256: fixture.sourceSha256,
    scmRevision: fixture.scmRevision, openapiSha256: fixture.openapiSha256, count: fixture.operations.length });
  assert.equal(listOperations({ search: 'user-storage/{componentId}/sync' }, merged).total, 1);
});

test('a supplement operation describes its request body and response from the supplement schemas', () => {
  const create = describeOperation(ROLE_POLICIES, catalog);
  assert.equal(create.origin, 'admin-client');
  assert.deepEqual(create.adminClient.at(-1), 'RolePoliciesResource#create(RolePolicyRepresentation)');
  assert.deepEqual(create.requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RolePolicyRepresentation' } } } });
  assert.deepEqual(create.responses, {});
  assert.deepEqual(describeOperation(SYNC, catalog).responses,
    { '2XX': { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/SynchronizationResultRepresentation' } } } } });
  assert.deepEqual(Object.keys(describeOperation(GRANT, catalog).responses['2XX'].content), ['*/*']);
  assert.equal(describeOperation(REFRESH, catalog).requestBody, null);
  assert.deepEqual(describeOperation(SYNC, catalog).parameters.map(({ name, in: location }) => `${location} ${name}`), ['path realm', 'path componentId', 'query action']);
});

test('schema names resolve in the OpenAPI components first, then in the supplement', () => {
  assert.deepEqual(describeSchema('SynchronizationResultRepresentation', catalog).schema, fixture.schemas.SynchronizationResultRepresentation);
  assert.equal(describeSchema('ClientRepresentation', catalog).schema, catalog.openapi.components.schemas.ClientRepresentation);
  const shadowed = withSupplement(openApiOnly(), { ...fixture, schemas: { ...fixture.schemas, ClientRepresentation: { type: 'string' } } });
  assert.equal(describeSchema('ClientRepresentation', shadowed).schema, catalog.openapi.components.schemas.ClientRepresentation);
  assert.throws(() => describeSchema('SynchronizationResultRepresentation', createCatalog('', 'latest')), /not in the pinned/);
  assert.throws(() => describeSchema('constructor', catalog), /not in the pinned/);
});

test('supplement operations take their classification from the admin-client route rules', () => {
  const rows = Object.fromEntries(fixture.operations.map(({ key }) => [key, [isMutation(key, catalog), isIrreversible(key, catalog),
    isSensitiveEndpoint(describeOperation(key, catalog))]]));
  assert.deepEqual(rows, {
    'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/role/{id}': [true, true, false],
    [GRANTS]: [false, false, false],
    'GET /admin/serverinfo': [false, false, false],
    [ROLE_POLICIES]: [true, false, false],
    [SYNC]: [true, true, false],
    [GRANT]: [true, false, false],
    [REFRESH]: [true, true, false],
  });
});

// A grant carries userAttributes, a snapshot of the user's attributes (JpaUserProvider.java:416-429,
// :496-502), so the attributes the operator declares secret stay hidden there as on the user itself.
test('verifiable-credential grants are returned with the operator\'s secret attributes redacted from their snapshot', async () => {
  const grant = { credentialScopeName: 'employee', revision: 'r1', userAttributes: { ssn: ['123-45-6789'], email: ['jane@example.com'] } };
  const redacted = { ...grant, userAttributes: { ssn: ['[REDACTED by keycloak-mcp]'], email: ['jane@example.com'] } };
  const read = async (key, value, settings = {}) => (await readResult(
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }),
    { op: describeOperation(key, catalog), config: testConfig({ KEYCLOAK_MCP_SECRET_ATTRIBUTES: 'ssn', ...settings }) })).value;
  assert.deepEqual(await read(GRANTS, [grant]), [redacted]);
  assert.deepEqual(await read(GRANT, grant), redacted);
  assert.deepEqual(await read(REFRESH, grant), redacted);
  assert.deepEqual(await read(GRANTS, [grant], { KEYCLOAK_MCP_ALLOW_SENSITIVE_READS: 'true' }), [grant]);
});

test('a supplement operation no route rule covers is an irreversible mutation with a withheld response', () => {
  const unreviewed = withSupplement(openApiOnly(), variant('GET /admin/serverinfo', { key: 'GET /admin/new-info', path: '/admin/new-info' }));
  const key = 'GET /admin/new-info';
  assert.deepEqual([isMutation(key, unreviewed), isIrreversible(key, unreviewed), isSensitiveEndpoint(describeOperation(key, unreviewed))], [true, true, true]);
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true', KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' });
  assert.throws(() => preflight(config, [{ operation: key }], unreviewed), /irreversible/);
});

test('supplement operations build requests under the same realm and query rules', () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true' });
  const sync = buildRequest(config, SYNC, { path: { componentId: 'ldap-1' }, query: { action: 'triggerFullSync' } }, catalog);
  assert.equal(sync.url, 'https://id.example.com/auth/admin/realms/test-realm/user-storage/ldap-1/sync?action=triggerFullSync');
  assert.throws(() => buildRequest(config, SYNC, { path: { componentId: 'ldap-1', realm: 'master' } }, catalog), /realm cannot be overridden/);
  assert.throws(() => buildRequest(config, SYNC, { path: { componentId: 'ldap-1' }, query: { direction: 'x' } }, catalog), /unknown query parameter/);
  assert.throws(() => buildRequest(testConfig(), 'GET /admin/serverinfo', {}, catalog), /realm administration is disabled/);
  assert.equal(buildRequest(testConfig({ KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' }), 'GET /admin/serverinfo', {}, catalog).url, 'https://id.example.com/auth/admin/serverinfo');
  const create = buildRequest(config, ROLE_POLICIES, { path: { 'client-uuid': 'c1' }, body: { name: 'p' } }, catalog);
  assert.equal(create.headers['content-type'], 'application/json');
});

test('a supplement that repeats a catalog route or describes an operation badly is refused', () => {
  const route = '/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource/{id}';
  assert.throws(() => withSupplement(openApiOnly(), variant(REFRESH, { key: `GET ${route}`, method: 'GET', path: route,
    parameters: ['realm', 'client-uuid', 'id'].map(name => ({ name, in: 'path', required: true, type: 'string' })) })),
  /repeats a catalog operation: GET .*\/resource\/\{id\}; regenerate data\/admin-client-supplement-nightly\.json with mvn/);
  assert.throws(() => withSupplement(openApiOnly(), withOperations([...fixture.operations, fixture.operations[0]])), /repeats a catalog operation/);
  for (const changes of [
    { key: 'PUT /admin/elsewhere' },
    { path: '/admin/realms/{realm}/users/{user-id}/vc/credentials/..', key: 'PUT /admin/realms/{realm}/users/{user-id}/vc/credentials/..' },
    { path: '/realms/{realm}/x', key: 'PUT /realms/{realm}/x' },
    { method: 'TRACE', key: 'TRACE /admin/realms/{realm}/users/{user-id}/vc/credentials/{credentialScopeName}' },
    { parameters: [] },
    { responseTypes: ['not a type'] },
    { adminClient: 'RealmResource#users()' },
  ]) assert.throws(() => withSupplement(openApiOnly(), variant(REFRESH, changes)), /invalid admin-client supplement operation/, JSON.stringify(changes));
  assert.throws(() => withSupplement(openApiOnly(), { ...fixture, operations: undefined }), /invalid admin-client supplement$/);
});
