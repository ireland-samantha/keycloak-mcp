import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFromEnv, createCatalog, describeOperation, describeSchema, KeycloakAdmin, listOperations, preflight, runWorkflow } from '../../src/api.js';
import { buildRequest } from '../../src/http/request.js';
import { execute } from '../../src/internal/capabilities.js';
import { isMutation } from '../../src/policy/classify.js';
import openclaw from '../../openclaw/index.js';
import { samplePathArgs } from '../support/catalog.js';
import { testConfig, testEnv } from '../support/config.js';
import { jsonResponse, tokenResponse } from '../support/fetch.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

test('catalog has one unique route for every pinned operation', () => {
  const page = listOperations({ limit: 100 });
  assert.equal(page.total, 413);
  const keys = [];
  for (let offset = 0; offset < page.total; offset += 100) keys.push(...listOperations({ offset, limit: 100 }).operations.map(op => op.key));
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(keys.length, 413);
  assert.deepEqual(describeOperation('GET /admin/realms/{realm}/clients').tags, ['Clients']);
  const clientCreate = describeOperation('POST /admin/realms/{realm}/clients');
  assert.equal(clientCreate.requestBody.content['application/json'].schema.$ref, '#/components/schemas/ClientRepresentation');
  assert.ok(describeSchema('ClientRepresentation').schema.properties.clientId);
  assert.throws(() => describeSchema('MissingRepresentation'), /not in/);
  assert.throws(() => describeOperation('GET https://evil.example'), /not in/);
});

test('versioned Keycloak 26.3.5 catalog matches the deployed API shape', () => {
  const versioned = createCatalog('', '26.3.5');
  assert.equal(listOperations({}, versioned).total, 374);
  assert.equal(versioned.version, '26.3.5');
  assert.ok(describeOperation('GET /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}/composites/clients/{targetClientUuid}', versioned));
  assert.throws(() => describeOperation('GET /admin/realms/{realm}/workflows', versioned), /not in/);
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true', KEYCLOAK_MCP_CATALOG_VERSION: '26.3.5' });
  const admin = new KeycloakAdmin(config, () => { throw new Error('network not expected'); });
  assert.equal(admin.catalog.operations.length, 374);
  let built = 0;
  for (const op of versioned.operations) {
    const path = samplePathArgs(op);
    assert.equal(new URL(buildRequest(config, op.key, { path }, versioned).url).origin, 'https://id.example.com');
    built += 1;
  }
  assert.equal(built, 374);
  assert.throws(() => createCatalog('', 'unreviewed'), /unsupported/);
});

test('26.3.5 federated identity creation accepts the JSON body consumed by Keycloak', () => {
  const versioned = createCatalog('', '26.3.5');
  const key = 'POST /admin/realms/{realm}/users/{user-id}/federated-identity/{provider}';
  const operation = describeOperation(key, versioned);
  assert.deepEqual(operation.requestTypes, ['application/json']);
  assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/FederatedIdentityRepresentation');
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_CATALOG_VERSION: '26.3.5' });
  const body = { identityProvider: 'test-idp', userId: 'external-123', userName: 'external-user' };
  const request = buildRequest(config, key, { path: { 'user-id': 'user-123', provider: 'test-idp' }, body }, versioned);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), body);
  assert.throws(() => buildRequest(config, 'DELETE /admin/realms/{realm}/users/{user-id}/federated-identity/{provider}',
    { path: { 'user-id': 'user-123', provider: 'test-idp' }, body }, versioned), /does not declare a request body/);
});

test('client description conversion is callable as a read without enabling writes', async () => {
  const key = 'POST /admin/realms/{realm}/client-description-converter';
  const versioned = createCatalog('', '26.3.5');
  assert.equal(isMutation(key, versioned), false);
  let calls = 0;
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_CATALOG_VERSION: '26.3.5' }), async url => {
    if (url.endsWith('/token')) return tokenResponse();
    calls += 1;
    return calls === 1 ? jsonResponse(503, { error: 'temporary' }) : jsonResponse(200, { clientId: 'converted-client' });
  });
  const converted = await admin.invoke(key, { contentType: 'text/plain', body: '{"client_id":"converted-client"}' });
  assert.equal(converted.status, 200);
  assert.equal(converted.attempts, 2);
  assert.equal(converted.value.clientId, 'converted-client');
  assert.equal(calls, 2);
  const plan = preflight(admin.config, [{ operation: key,
    args: { contentType: 'text/plain', body: '{"client_id":"converted-client"}' } }], versioned);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].compensate, null);
  await assert.rejects(() => admin.invoke('POST /admin/realms/{realm}/users', { body: { username: 'blocked' } }),
    /compensating workflow/);
  assert.equal(calls, 2);
});

test('every catalog route can be built without leaving the configured Keycloak origin', () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' });
  let built = 0;
  for (let offset = 0; offset < 413; offset += 100) {
    for (const item of listOperations({ offset, limit: 100 }).operations) {
      const op = describeOperation(item.key);
      const path = samplePathArgs(op);
      const request = buildRequest(config, item.key, { path });
      assert.equal(new URL(request.url).origin, 'https://id.example.com');
      assert.ok(new URL(request.url).pathname.startsWith('/auth/admin/realms'));
      built += 1;
    }
  }
  assert.equal(built, 413);
});

test('declared JSON, form, multipart, and text request types are serializable', () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' });
  const found = new Set();
  for (let offset = 0; offset < 413; offset += 100) {
    for (const item of listOperations({ offset, limit: 100 }).operations) {
      const op = describeOperation(item.key);
      const path = samplePathArgs(op);
      for (const contentType of op.requestTypes) {
        const body = contentType === 'application/json' ? { sample: 'value' } :
          contentType === 'application/x-www-form-urlencoded' || contentType === 'multipart/form-data' ? { sample: 'value' } : 'sample';
        const built = buildRequest(config, item.key, { path, body, contentType });
        assert.equal(built.headers['content-type'], contentType === 'multipart/form-data' ? undefined : contentType);
        assert.ok(built.body);
        found.add(contentType);
      }
    }
  }
  assert.deepEqual([...found].sort(), ['application/json', 'application/x-www-form-urlencoded', 'application/xml', 'application/yaml', 'multipart/form-data', 'text/plain']);
  const formOperation = listOperations({ method: 'POST', limit: 100 }).operations.map(item => describeOperation(item.key)).find(op => op.requestTypes.includes('application/x-www-form-urlencoded'));
  const path = samplePathArgs(formOperation);
  const repeated = buildRequest(config, formOperation.key, { path, contentType: 'application/x-www-form-urlencoded', body: { value: ['one', 'two'] } });
  assert.equal(repeated.body, 'value=one&value=two');
});

test('every declared query and request type builds in both official catalogs', () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true' });
  const counts = {};
  for (const version of ['latest', '26.3.5']) {
    const catalog = createCatalog('', version);
    let queryChecks = 0;
    let bodyChecks = 0;
    for (const op of catalog.operations) {
      const path = samplePathArgs(op);
      for (const parameter of op.parameters.filter(p => p.in === 'query')) {
        const url = new URL(buildRequest(config, op.key, { path, query: { [parameter.name]: 'sample' } }, catalog).url);
        assert.equal(url.searchParams.get(parameter.name), 'sample');
        queryChecks += 1;
      }
      for (const contentType of op.requestTypes) {
        const body = contentType === 'application/json' ? { sample: 'value' } : contentType === 'application/x-www-form-urlencoded' ? { sample: 'value' } : 'sample';
        const request = buildRequest(config, op.key, { path, body, contentType }, catalog);
        assert.equal(request.headers['content-type'], contentType);
        assert.ok(request.body);
        bodyChecks += 1;
      }
    }
    counts[version] = { queryChecks, bodyChecks };
  }
  assert.ok(counts.latest.queryChecks > 0 && counts['26.3.5'].queryChecks > 0);
  assert.ok(counts.latest.bodyChecks > 0 && counts['26.3.5'].bodyChecks > 0);
});

test('private JSON config is loaded; group-readable credentials are rejected', () => {
  const dir = privateTempDir('keycloak-mcp-test-');
  const file = join(dir, 'config.local.json');
  writePrivateJson(file, testEnv);
  assert.equal(configFromEnv({ KEYCLOAK_MCP_CONFIG: file }).clientId, testEnv.KEYCLOAK_CLIENT_ID);
  chmodSync(file, 0o644);
  assert.throws(() => configFromEnv({ KEYCLOAK_MCP_CONFIG: file }), /private file/);
});

test('configuration accepts only service account credentials and a safe base URL', () => {
  assert.equal(configFromEnv(testEnv).allowWrite, false);
  assert.throws(() => configFromEnv({ ...testEnv, KEYCLOAK_BASE_URL: 'http://id.example.com' }), /HTTPS/);
  assert.throws(() => configFromEnv({ ...testEnv, KEYCLOAK_BASE_URL: 'https://name@id.example.com' }), /credentials/);
  assert.throws(() => configFromEnv({ ...testEnv, KEYCLOAK_REALM: '../master' }), /invalid/);
});

test('private SPI catalog is realm pinned and excludes user-token routes from service-account calls', async () => {
  const dir = privateTempDir('keycloak-mcp-spi-');
  const file = join(dir, 'extensions.json');
  const operations = [
    { method: 'GET', path: '/realms/{realm}/sample', readOnly: true, serviceAccountSupported: true, responseTypes: ['application/json'] },
    { method: 'GET', path: '/realms/{realm}/sample/user', readOnly: true, serviceAccountSupported: false },
    { method: 'POST', path: '/realms/{realm}/sample/rotate', serviceAccountSupported: true, requestTypes: ['application/json'] },
  ];
  writePrivateJson(file, { source: 'test provider', operations });
  const config = testConfig({ KEYCLOAK_MCP_EXTENSION_CATALOG: file });
  const admin = new KeycloakAdmin(config, async (url) => url.endsWith('/token')
    ? tokenResponse() : jsonResponse(200, { realm: 'test-realm' }));
  assert.equal(listOperations({}, admin.catalog).total, 416);
  assert.equal((await admin.invoke('GET /realms/{realm}/sample')).status, 200);
  await assert.rejects(() => admin.invoke('GET /realms/{realm}/sample/user'), /non-service-account/);
  await assert.rejects(() => admin.invoke('POST /realms/{realm}/sample/rotate'), /compensating workflow/);
  assert.throws(() => preflight(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }),
    [{ operation: 'POST /realms/{realm}/sample/rotate', args: { body: {} } }], admin.catalog), /irreversible/);
  const bad = [
    { method: 'GET', path: 'https://evil.example/realms/{realm}/x', readOnly: true, serviceAccountSupported: true },
    { method: 'GET', path: '/realms/{realm}/../admin', readOnly: true, serviceAccountSupported: true },
    { method: 'GET', path: '/realms/{realm}/%2e%2e/admin', readOnly: true, serviceAccountSupported: true },
  ];
  for (const item of bad) {
    writePrivateJson(file, { source: 'test provider', operations: [item] });
    assert.throws(() => createCatalog(file), /invalid extension operation/);
  }
  chmodSync(file, 0o644);
  assert.throws(() => createCatalog(file), /private file/);
});

test('URL builder pins realm, encodes values, and rejects traversal and unlisted queries', () => {
  const config = testConfig();
  const key = 'GET /admin/realms/{realm}/users/{user-id}';
  const params = describeOperation(key).parameters.filter(p => p.in === 'path' && p.name !== 'realm');
  const path = Object.fromEntries(params.map(p => [p.name, 'safe-id']));
  const built = buildRequest(config, key, { path });
  assert.ok(built.url.startsWith('https://id.example.com/auth/admin/realms/test-realm/'));
  assert.throws(() => buildRequest(config, key, { path: { ...path, realm: 'master' } }), /realm cannot/);
  const first = params[0]?.name;
  if (first) assert.throws(() => buildRequest(config, key, { path: { ...path, [first]: '..' } }), /unsafe path/);
  assert.throws(() => buildRequest(config, key, { path, query: { malicious: 1 } }), /unknown query/);
  const group = buildRequest(config, 'GET /admin/realms/{realm}/group-by-path/{path}', { path: { path: '/parent/child' } });
  assert.ok(group.url.endsWith('/group-by-path/parent/child'));
  assert.throws(() => buildRequest(config, 'GET /admin/realms/{realm}/group-by-path/{path}', { path: { path: '/parent/../child' } }), /unsafe group path/);
});

test('GET uses client_credentials, reuses token, and redacts sensitive fields', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/token')) return tokenResponse('token-value');
    return jsonResponse(200, { realm: 'test-realm', smtpServer: { password: 'hidden' }, clients: [{ clientId: 'app', secret: 'hidden' }] });
  };
  const admin = new KeycloakAdmin(testConfig(), fetch);
  const first = await admin.invoke('GET /admin/realms/{realm}');
  await admin.invoke('GET /admin/realms/{realm}');
  assert.equal(first.value.smtpServer.password, '[REDACTED by keycloak-mcp]');
  assert.equal(first.value.clients[0].secret, '[REDACTED by keycloak-mcp]');
  assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.equal(calls[0].options.body.get('grant_type'), 'client_credentials');
  assert.equal(calls[1].url, 'https://id.example.com/auth/admin/realms/test-realm');
  await assert.rejects(() => admin.invoke('DELETE /admin/realms/{realm}'), /compensating workflow/);
});

test('transient 503 is retried for a safe read and reported with an attempt count', async () => {
  let reads = 0;
  const admin = new KeycloakAdmin(testConfig(), async url => {
    if (url.endsWith('/token')) return tokenResponse();
    reads += 1;
    return reads === 1 ? jsonResponse(503, {}) : jsonResponse(200, { realm: 'test-realm' });
  });
  const result = await admin.invoke('GET /admin/realms/{realm}');
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
  assert.equal(reads, 2);
});

test('a rejected cached token refreshes once for a GET and never replays a mutation', async () => {
  let tokens = 0;
  let reads = 0;
  let writes = 0;
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
    KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse(`token-${++tokens}`);
    if (options.method === 'GET') {
      reads += 1;
      return ['Bearer token-2', 'Bearer token-3'].includes(options.headers.authorization)
        ? jsonResponse(200, { realm: 'test-realm' }) : jsonResponse(401, {});
    }
    writes += 1;
    return jsonResponse(401, {});
  });
  const read = await admin.invoke('GET /admin/realms/{realm}');
  assert.equal(read.status, 200);
  assert.equal(read.attempts, 2);
  assert.equal(reads, 2);
  await assert.rejects(() => execute(admin, 'POST /admin/realms/{realm}/logout-all'), /HTTP 401; attempts 1/);
  assert.equal(writes, 1);
  assert.equal(tokens, 2);
  const again = await admin.invoke('GET /admin/realms/{realm}');
  assert.equal(again.status, 200);
  assert.equal(tokens, 3);
});

test('logout-all refreshes the service token before the next workflow step', async () => {
  let tokens = 0;
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
    KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse(`token-${++tokens}`);
    calls.push([options.method, options.headers.authorization]);
    if (url.endsWith('/logout-all')) return jsonResponse(204, null);
    return options.headers.authorization === 'Bearer token-2' ? jsonResponse(200, { realm: 'test-realm' }) : jsonResponse(401, {});
  });
  const result = await runWorkflow(admin, [
    { operation: 'POST /admin/realms/{realm}/logout-all', irreversible: true },
    { operation: 'GET /admin/realms/{realm}' },
  ], { dryRun: false });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(tokens, 2);
  assert.deepEqual(calls, [['POST', 'Bearer token-1'], ['GET', 'Bearer token-2']]);
});

test('transient 503 never retries a mutating workflow step', async () => {
  let writes = 0;
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' });
  const admin = new KeycloakAdmin(config, async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    if (options.method === 'POST') writes += 1;
    return jsonResponse(503, {});
  });
  const result = await runWorkflow(admin, [{ operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'group' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } }], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(writes, 1);
});

test('generic secret value endpoint is redacted unless explicitly enabled', async () => {
  const fetch = async (url) => url.endsWith('/token')
    ? tokenResponse()
    : jsonResponse(200, { type: 'secret', value: 'hidden-secret' });
  const key = 'GET /admin/realms/{realm}/clients/{client-uuid}/client-secret';
  const args = { path: { 'client-uuid': 'client-1' } };
  const ordinary = await new KeycloakAdmin(testConfig(), fetch).invoke(key, args);
  assert.equal(ordinary.value, '[REDACTED by keycloak-mcp: sensitive endpoint]');
  const enabled = await new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_SENSITIVE_READS: 'true' }), fetch).invoke(key, args);
  assert.equal(enabled.value.value, 'hidden-secret');
});

test('client initial-access tokens and detailed admin-event representations are redacted by default', async () => {
  const initialAccess = 'GET /admin/realms/{realm}/clients-initial-access';
  const adminEvents = 'GET /admin/realms/{realm}/admin-events';
  const fetch = async url => {
    if (url.endsWith('/token')) return tokenResponse('service-token');
    if (url.endsWith('/clients-initial-access')) return jsonResponse(200, [{ id: 'entry', token: 'registration-token' }]);
    return jsonResponse(200, [{ operationType: 'CREATE', representation: '{"secret":"client-secret"}' }]);
  };
  const ordinary = new KeycloakAdmin(testConfig(), fetch);
  assert.equal((await ordinary.invoke(initialAccess)).value, '[REDACTED by keycloak-mcp: sensitive endpoint]');
  const events = (await ordinary.invoke(adminEvents)).value;
  assert.equal(events[0].operationType, 'CREATE');
  assert.equal(events[0].representation, '[REDACTED by keycloak-mcp]');
  const enabled = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_SENSITIVE_READS: 'true' }), fetch);
  assert.equal((await enabled.invoke(initialAccess)).value[0].token, 'registration-token');
  assert.equal((await enabled.invoke(adminEvents)).value[0].representation, '{"secret":"client-secret"}');
});

test('text installation material and example tokens are redacted by default', async () => {
  const admin = new KeycloakAdmin(testConfig(), async url => {
    if (url.endsWith('/token')) return tokenResponse();
    return new Response('<private>client-secret</private>', { status: 200, headers: { 'content-type': 'text/plain' } });
  });
  for (const [operation, path] of [
    ['GET /admin/realms/{realm}/clients/{client-uuid}/installation/providers/{providerId}', { 'client-uuid': 'client', providerId: 'provider' }],
    ['GET /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}', { 'client-uuid': 'client', attr: 'jwt.credential' }],
    ['GET /admin/realms/{realm}/clients/{client-uuid}/evaluate-scopes/generate-example-saml-response', { 'client-uuid': 'client' }],
  ]) {
    const result = await admin.invoke(operation, { path });
    assert.equal(result.value, '[REDACTED by keycloak-mcp: sensitive endpoint]');
  }
});

test('certificate downloads never expose returned keystore bytes by default', async () => {
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
    KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async url => url.endsWith('/token')
    ? tokenResponse()
    : new Response(Buffer.from('private-keystore'), { status: 200,
      headers: { 'content-type': 'application/octet-stream' } }));
  for (const operation of [
    'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/download',
    'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/generate-and-download',
  ]) {
    const result = await execute(admin, operation, { path: { 'client-uuid': 'client', attr: 'jwt.credential' },
      body: { format: 'JKS', keyAlias: 'key', keyPassword: 'password', storePassword: 'password' } });
    assert.equal(result.value, '[REDACTED by keycloak-mcp: sensitive endpoint]');
  }
});

test('response limit stops the stream before buffering the entire oversized body', async () => {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled <= 8) controller.enqueue(new Uint8Array(256 * 1024));
      else controller.close();
    },
    cancel() { cancelled = true; },
  });
  const admin = new KeycloakAdmin(testConfig(), async url => url.endsWith('/token')
    ? tokenResponse()
    : new Response(stream, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  await assert.rejects(() => admin.invoke('GET /admin/realms/{realm}'), /response exceeds/);
  assert.ok(pulled < 8, `buffered ${pulled} chunks before rejecting`);
  assert.equal(cancelled, true);
});

test('private body limit permits a larger Admin API payload within a bounded maximum', async () => {
  const large = 'x'.repeat(1_200_000);
  const key = 'POST /admin/realms/{realm}/users';
  const base = { KEYCLOAK_MCP_ALLOW_WRITE: 'true' };
  assert.throws(() => buildRequest(testConfig(base), key, { body: { firstName: large } }), /request body exceeds/);
  const config = testConfig({ ...base, KEYCLOAK_MCP_MAX_BODY_BYTES: '2097152' });
  assert.equal(config.maxBodyBytes, 2097152);
  assert.ok(buildRequest(config, key, { body: { firstName: large } }).body.length > 1024 * 1024);
  assert.throws(() => testConfig({ ...base, KEYCLOAK_MCP_MAX_BODY_BYTES: '9999999999' }), /MAX_BODY_BYTES/);
});

test('workflow preflight blocks writes without a lock or compensation before network', async () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true' });
  const step = { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'sample' } } };
  assert.throws(() => preflight(config, [step]), /compensation/);
  assert.throws(() => preflight(config, [{ ...step, compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } }]), /lock/);
  const admin = new KeycloakAdmin(config, () => { throw new Error('network used'); });
  await assert.rejects(() => runWorkflow(admin, [step]), /compensation/);
});

test('global realm creation cannot compensate by deleting a different pinned realm', async () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
    KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' });
  const compensate = { operation: 'DELETE /admin/realms/{realm}', args: {} };
  const admin = new KeycloakAdmin(config, () => { throw new Error('network used'); });
  const mismatched = { operation: 'POST /admin/realms', args: { body: { realm: 'other-realm' } }, compensate };
  await assert.rejects(() => runWorkflow(admin, [mismatched]), /must name the configured realm/);
  const missingDelete = { operation: 'POST /admin/realms', args: { body: { realm: 'test-realm' } },
    compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: {} } } };
  await assert.rejects(() => runWorkflow(admin, [missingDelete]), /must compensate by deleting that realm/);
  const valid = { operation: 'POST /admin/realms', args: { body: { realm: 'test-realm', enabled: true } }, compensate };
  assert.equal((await runWorkflow(admin, [valid])).status, 'PREFLIGHT_OK');
});

test('realm-create compensation refreshes a service-account token before DELETE', async () => {
  let tokenRequests = 0;
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
    KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) {
      tokenRequests += 1;
      return tokenResponse(`token-${tokenRequests}`);
    }
    calls.push({ method: options.method, authorization: options.headers.authorization });
    if (options.method === 'POST') return jsonResponse(201, null);
    if (options.method === 'GET') return jsonResponse(404, {});
    if (options.method === 'DELETE' && options.headers.authorization === 'Bearer token-2') return jsonResponse(204, null);
    return jsonResponse(403, {});
  });
  const result = await runWorkflow(admin, [
    { operation: 'POST /admin/realms', args: { body: { realm: 'test-realm' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}', args: {} } },
    { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.priorStepsCompensated, true);
  assert.equal(result.rollback[0].status, 204);
  assert.equal(tokenRequests, 2);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'DELETE']);
});

test('known irreversible operations need a two-part explicit override', () => {
  const step = { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'sample' } } };
  const base = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
  assert.throws(() => preflight(testConfig(base), [step]), /irreversible/);
  assert.throws(() => preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), [step]), /irreversible/);
  assert.equal(preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), [{ ...step, irreversible: true }])[0].irreversible, true);
});

test('operator can classify an otherwise compensatable mutation as irreversible', () => {
  const step = { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'group' } }, irreversible: true };
  const base = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
  assert.throws(() => preflight(testConfig(base), [step]), /irreversible/);
  const plan = preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), [step]);
  assert.equal(plan[0].irreversible, true);
  assert.throws(() => preflight(testConfig(base), [{ operation: 'GET /admin/realms/{realm}', irreversible: true }]), /read-only/);
});

test('OpenClaw extension registers the five shared tools', () => {
  const names = [];
  const old = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, testEnv);
  try { openclaw.register({ registerTool(definition) { assert.equal(typeof definition, 'object'); names.push(definition.name); } }); }
  finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.deepEqual(names, ['keycloak_search_operations', 'keycloak_describe_operation', 'keycloak_describe_schema', 'keycloak_read', 'keycloak_workflow']);
});

test('OpenClaw manifest declares every registered tool and the package entry', () => {
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const manifest = read('../../openclaw.plugin.json');
  const pkg = read('../../package.json');
  const names = [];
  const old = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, testEnv);
  try { openclaw.register({ registerTool(definition) { names.push(definition.name); } }); }
  finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  // OpenClaw discovers tool ownership from contracts.tools before importing plugin code.
  assert.equal(manifest.id, openclaw.id);
  assert.deepEqual(manifest.contracts?.tools, names);
  assert.deepEqual(Object.keys(manifest.toolMetadata ?? {}), names);
  assert.equal(manifest.toolMetadata?.keycloak_workflow?.replaySafe, false);
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(pkg.openclaw.extensions, ['./openclaw/index.js']);
  assert.equal(pkg.exports['./openclaw'], './openclaw/index.js');
  assert.ok(pkg.files.includes('openclaw') && pkg.files.includes('openclaw.plugin.json'));
});

test('OpenClaw read tool accepts classified converter POSTs and refuses mutations', async () => {
  const dir = privateTempDir('keycloak-mcp-openclaw-read-');
  const file = join(dir, 'service-account.json');
  writePrivateJson(file, testEnv);
  const tools = new Map();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls += 1;
    assert.equal(options.method, 'POST');
    return jsonResponse(200, { clientId: 'converted-client' });
  };
  try {
    openclaw.register({ pluginConfig: { configPath: file }, registerTool(definition) { tools.set(definition.name, definition); } });
    const read = tools.get('keycloak_read');
    const converted = await read.execute('read-call', { operation: 'POST /admin/realms/{realm}/client-description-converter',
      args: { contentType: 'text/plain', body: '{"client_id":"converted-client"}' } });
    assert.equal(converted.details.value.clientId, 'converted-client');
    const blocked = await read.execute('write-call', { operation: 'POST /admin/realms/{realm}/users',
      args: { body: { username: 'blocked' } } });
    assert.match(blocked.content[0].text, /compensating workflow/);
    assert.deepEqual(blocked.details, { ok: false, error: 'mutations require a compensating workflow' });
    assert.equal(converted.details.ok, undefined);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenClaw plugin config selects a private service-account file', () => {
  const dir = privateTempDir('keycloak-mcp-openclaw-config-');
  const file = join(dir, 'service-account.json');
  writePrivateJson(file, { ...testEnv, KEYCLOAK_CLIENT_ID: 'openclaw-service' });
  const old = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, testEnv);
  try {
    process.env.KEYCLOAK_BASE_URL = 'http://untrusted.example';
    openclaw.register({ pluginConfig: { configPath: file }, registerTool() {} });
    assert.throws(() => openclaw.register({ registerTool() {} }), /HTTPS or loopback HTTP/);
    chmodSync(file, 0o644);
    assert.throws(() => openclaw.register({ pluginConfig: { configPath: file }, registerTool() {} }), /private file/);
    assert.throws(() => openclaw.register({ pluginConfig: { configPath: 'relative.json' }, registerTool() {} }), /absolute/);
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('KeycloakAdmin offers no public way around the read guard and workflow preflight', async () => {
  const admin = new KeycloakAdmin(testConfig(), () => { throw new Error('network not expected'); });
  assert.equal(admin._invoke, undefined);
  // Neither reflection over string keys nor over symbol keys finds another way to send a request.
  assert.deepEqual(Object.getOwnPropertyNames(KeycloakAdmin.prototype), ['constructor', 'invalidateToken', 'token', 'invoke']);
  assert.deepEqual(Object.getOwnPropertySymbols(KeycloakAdmin.prototype), []);
  assert.deepEqual(Object.getOwnPropertyNames(admin), ['config', 'catalog']);
  assert.deepEqual(Object.getOwnPropertySymbols(admin), []);
  await assert.rejects(admin.invoke('DELETE /admin/realms/{realm}/users/{user-id}', { path: { 'user-id': 'u1' } }), /compensating workflow/);
  assert.throws(() => execute({ ...admin }, 'GET /admin/realms/{realm}', {}), /need a KeycloakAdmin/);
});
