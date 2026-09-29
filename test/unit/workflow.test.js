import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalog, KeycloakAdmin, preflight, runWorkflow, WorkflowBuilder } from '../../src/api.js';
import { catalogFor } from '../../src/catalog/index.js';
import { buildRequest } from '../../src/http/request.js';
import { isIrreversible, isMutation } from '../../src/policy/classify.js';
import { catalogVersions, samplePathArgs } from '../support/catalog.js';
import { testConfig } from '../support/config.js';
import { jsonResponse, tokenResponse } from '../support/fetch.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

// Which operations mutate is pinned per operation by test/unit/fixtures/classification-<version>.json.
test('every official mutation requires compensation or an irreversible override before network', () => {
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    const config = testConfig({ KEYCLOAK_MCP_CATALOG_VERSION: version,
      KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true',
      KEYCLOAK_MCP_SINGLE_WRITER: 'true' });
    const mutations = catalog.operations.filter(operation => isMutation(operation.key, catalog));
    assert.ok(mutations.length > 0, version);
    for (const operation of mutations) {
      const path = samplePathArgs(operation);
      const args = { path, ...(operation.key === 'POST /admin/realms' ? { body: { realm: config.realm } } : {}) };
      assert.throws(() => preflight(config, [{ operation: operation.key, args }], catalog),
        /compensat|irreversible/, operation.key);
    }
  }
});

test('preflight refuses destructive or caller-chosen create compensation targets', () => {
  for (const override of [false, true]) {
    const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
      KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: String(override) });
    assert.throws(() => preflight(config, [{ operation: 'PUT /admin/realms/{realm}',
      args: { body: { displayName: 'changed' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}', args: {} },
      ...(override ? { irreversible: true } : {}) }]), /irreversible compensation|same resource/);
    assert.throws(() => preflight(config, [{ operation: 'PUT /admin/realms/{realm}',
      args: { body: { displayName: 'changed' } },
      compensate: { operation: 'PUT /admin/realms/{realm}/users/profile', args: { body: {} } } }]), /same resource/);
    for (const [collection, idName] of [['groups', 'group-id'], ['users', 'user-id']]) {
      assert.throws(() => preflight(config, [{ operation: `POST /admin/realms/{realm}/${collection}`,
        args: { body: { name: 'new-resource' } },
        compensate: { operation: `DELETE /admin/realms/{realm}/${collection}/{${idName}}`,
          args: { path: { [idName]: 'existing-resource-id' } } } }]), /generated-ID binding/);
    }
    assert.throws(() => preflight(config, [{ operation: 'POST /admin/realms/{realm}/users',
      args: { body: { username: 'new-user' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}',
        args: { path: { 'group-id': 'existing-group-id' } } } }]), /created resource/);
    assert.equal(preflight(config, [{ operation: 'POST /admin/realms/{realm}/users',
      args: { body: { username: 'new-user' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}',
        args: { path: { 'user-id': '$step.locationId' } } } }])[0].operation,
      'POST /admin/realms/{realm}/users');
  }
});

test('preflight refuses unrelated POST compensation and different resource bindings', () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
    KEYCLOAK_MCP_SINGLE_WRITER: 'true' });
  assert.throws(() => preflight(config, [{
    operation: 'POST /admin/realms/{realm}/users/{user-id}/role-mappings/realm',
    args: { path: { 'user-id': 'user-a' }, body: [{ name: 'sat-accessor-admin' }] },
    compensate: { operation: 'POST /admin/realms/{realm}/groups',
      args: { body: { name: 'unrelated' } } },
  }]), /compensation must delete the created resource/);
  assert.throws(() => preflight(config, [{
    operation: 'POST /admin/realms/{realm}/users',
    args: { body: { username: 'new-user' } },
    compensate: { operation: 'PUT /admin/realms/{realm}',
      args: { body: { displayName: 'unrelated' } } },
  }]), /compensation must delete the created resource/);
  assert.throws(() => preflight(config, [{
    operation: 'PUT /admin/realms/{realm}/users/{user-id}',
    args: { path: { 'user-id': 'user-a' }, body: { firstName: 'new' } },
    compensate: { operation: 'PUT /admin/realms/{realm}/users/{user-id}',
      args: { path: { 'user-id': 'user-b' }, body: { firstName: 'old' } } },
  }]), /update compensation must target the same resource/);
  assert.throws(() => preflight(config, [{
    operation: 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource',
    args: { path: { 'client-uuid': 'client-a' }, body: { name: 'new-resource' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource/{resource-id}',
      args: { path: { 'client-uuid': 'client-b', 'resource-id': '$step.responseId' } } },
  }]), /created resource.*parent/);
});

test('named create compensation must delete the exact new role or identity-provider alias', () => {
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' });
  for (const [collection, parameter, bodyKey, body, parent] of [
    ['roles', 'role-name', 'name', { name: 'new-role' }, {}],
    ['clients/{client-uuid}/roles', 'role-name', 'name', { name: 'new-role' }, { 'client-uuid': 'client-a' }],
    ['identity-provider/instances', 'alias', 'alias', { alias: 'new-idp', providerId: 'oidc' }, {}],
  ]) {
    const operation = `POST /admin/realms/{realm}/${collection}`;
    const compensate = { operation: `DELETE /admin/realms/{realm}/${collection}/{${parameter}}`,
      args: { path: { ...parent, [parameter]: body[bodyKey] } } };
    assert.equal(preflight(config, [{ operation, args: { path: parent, body }, compensate }])[0].operation, operation);
    for (const target of ['existing-name', '']) {
      assert.throws(() => preflight(config, [{ operation, args: { path: parent, body },
        compensate: { ...compensate, args: { path: { ...parent, [parameter]: target } } } }]),
      /irreversible compensation|generated-ID binding/);
    }
    assert.throws(() => preflight(config, [{ operation, args: { path: parent, body: {} }, compensate }]),
      /irreversible compensation/);
  }
});

test('named create rollback deletes the created role by ID and the identity provider by its rechecked alias', async () => {
  const createdRole = 'baebccda-a5cd-4ed8-a889-c95e4cf2d64b';
  for (const [collection, parameter, body, lookedUp, deleted] of [
    ['roles', 'role-name', { name: 'new-role' }, { id: createdRole, name: 'new-role' }, `roles-by-id/${createdRole}`],
    ['identity-provider/instances', 'alias', { alias: 'new-idp', providerId: 'oidc' }, { alias: 'new-idp', internalId: createdRole },
      'identity-provider/instances/new-idp'],
  ]) {
    const name = body.name ?? body.alias;
    const calls = [];
    const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true',
      KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
      if (url.endsWith('/token')) return tokenResponse();
      calls.push(`${options.method} ${new URL(url).pathname}`);
      if (options.method === 'POST') return jsonResponse(201, null);
      if (options.method === 'GET') return url.endsWith(`/${name}`) ? jsonResponse(200, lookedUp) : jsonResponse(404, {});
      return jsonResponse(204, null);
    });
    const result = await runWorkflow(admin, [
      { operation: `POST /admin/realms/{realm}/${collection}`, args: { body },
        compensate: { operation: `DELETE /admin/realms/{realm}/${collection}/{${parameter}}`,
          args: { path: { [parameter]: name } } } },
      { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } },
    ], { dryRun: false });
    assert.equal(result.status, 'IN_DOUBT');
    assert.equal(result.priorStepsCompensated, true);
    assert.equal(calls.at(-1), `DELETE /auth/admin/realms/test-realm/${deleted}`);
  }
});

test('existing-resource deletes and external actions require an irreversible override', () => {
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    const deletes = catalog.operations.filter(operation => operation.method === 'DELETE');
    assert.ok(deletes.length > 0, version);
    assert.ok(deletes.every(operation => isIrreversible(operation.key, catalog)));
    for (const key of [
      'GET /admin/realms/{realm}/identity-provider/instances/{alias}/reload-keys',
      'POST /admin/realms/{realm}/push-revocation',
      'POST /admin/realms/{realm}/testSMTPConnection',
      'POST /admin/realms/{realm}/users/{user-id}/impersonation',
      'PUT /admin/realms/{realm}/users/{user-id}/disable-credential-types',
      'POST /admin/realms/{realm}/identity-provider/import-config',
      'POST /admin/realms/{realm}/organizations/{org-id}/members/invite-existing-user',
      'POST /admin/realms/{realm}/organizations/{org-id}/members/invite-user',
    ]) assert.equal(isIrreversible(key, catalog), true, key);
  }
  const step = { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}',
    args: { path: { 'group-id': 'existing-id' } },
    compensate: { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'same-name' } } } };
  const base = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
  assert.throws(() => preflight(testConfig(base), [step]), /irreversible/);
  assert.throws(() => preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), [step]), /irreversible/);
  const allowed = preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }),
    [{ operation: step.operation, args: step.args, irreversible: true }]);
  assert.equal(allowed[0].irreversible, true);

  const disable = { operation: 'PUT /admin/realms/{realm}/users/{user-id}/disable-credential-types',
    args: { path: { 'user-id': 'existing-id' }, body: ['password'] },
    compensate: { operation: 'PUT /admin/realms/{realm}/users/{user-id}/disable-credential-types',
      args: { path: { 'user-id': 'existing-id' }, body: ['password'] } } };
  assert.throws(() => preflight(testConfig(base), [disable]), /irreversible/);
  assert.throws(() => preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), [disable]), /irreversible/);
  const explicitlyAllowed = preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }),
    [{ operation: disable.operation, args: disable.args, irreversible: true }]);
  assert.equal(explicitlyAllowed[0].irreversible, true);
});

test('bodyless association PUTs cannot claim a repeated PUT as rollback', () => {
  const base = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    const associations = catalog.operations.filter(operation => operation.method === 'PUT' &&
      operation.requestTypes.length === 0 && catalog.byKey.has(`DELETE ${operation.path}`));
    assert.ok(associations.length >= 6, `${version} association routes`);
    for (const operation of associations) {
      assert.equal(isIrreversible(operation.key, catalog), true, operation.key);
      const path = samplePathArgs(operation, 'test-id');
      const step = { operation: operation.key, args: { path },
        compensate: { operation: operation.key, args: { path } } };
      assert.throws(() => preflight(testConfig(base), [step], catalog), /irreversible/, operation.key);
      const allowed = preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }),
        [{ operation: operation.key, args: { path }, irreversible: true }], catalog);
      assert.equal(allowed[0].irreversible, true);
    }
  }
});

test('latest invitation resend and workflow execution actions cannot claim a compensating undo', () => {
  const catalog = createCatalog('', 'latest');
  const base = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
  const actions = [
    ['POST /admin/realms/{realm}/organizations/{org-id}/invitations/{id}/resend',
      { path: { 'org-id': 'org-id', id: 'invitation-id' } }],
    ['POST /admin/realms/{realm}/workflows/migrate', { query: { from: 'step-a', to: 'step-b' } }],
    ['POST /admin/realms/{realm}/workflows/{id}/activate/{type}/{resourceId}',
      { path: { id: 'workflow-id', type: 'USERS', resourceId: 'user-id' } }],
    ['POST /admin/realms/{realm}/workflows/{id}/deactivate/{type}/{resourceId}',
      { path: { id: 'workflow-id', type: 'USERS', resourceId: 'user-id' } }],
  ];
  for (const [operation, args] of actions) {
    assert.equal(isIrreversible(operation, catalog), true, operation);
    const compensated = [{ operation, args, compensate: { operation, args } }];
    assert.throws(() => preflight(testConfig(base), compensated, catalog), /irreversible/, operation);
    assert.throws(() => preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }),
      compensated, catalog), /irreversible/, operation);
    const explicit = preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }),
      [{ operation, args, irreversible: true }], catalog);
    assert.equal(explicit[0].irreversible, true);
  }
});

test('saga compensates completed mutations in reverse after a later failure', async () => {
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (url.endsWith('/users') && options.method === 'POST')
      return jsonResponse(201, null, { location: 'https://id.example.com/auth/admin/realms/test-realm/users/user-1' });
    if (url.endsWith('/groups') && options.method === 'POST') return jsonResponse(500, {});
    return jsonResponse(204, null);
  });
  const steps = [
    { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'changed' } },
      compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'original' } } } },
    { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'sample' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } },
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'sample' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
  ];
  const dry = await runWorkflow(admin, steps);
  assert.equal(dry.status, 'PREFLIGHT_OK');
  assert.equal(calls.length, 0);
  const result = await new WorkflowBuilder(admin)
    .step(steps[0].operation, steps[0].args, steps[0].compensate)
    .step(steps[1].operation, steps[1].args, steps[1].compensate)
    .step(steps[2].operation, steps[2].args, steps[2].compensate).run();
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.priorStepsCompensated, true);
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(calls.map(value => value.split(' ')[0]), ['PUT', 'POST', 'POST', 'DELETE', 'PUT']);
});

test('failed read does not claim the failed step may have committed', async () => {
  const dir = privateTempDir('keycloak-mcp-read-failure-');
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_JOURNAL_DIR: dir }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    if (options.method === 'POST') return jsonResponse(201, null, { location: 'https://id.example.com/auth/admin/realms/test-realm/groups/new-group' });
    if (options.method === 'DELETE') return jsonResponse(204, null);
    return jsonResponse(404, {});
  });
  const result = await runWorkflow(admin, [
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'new-group' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
    { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'absent' } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, false);
  assert.equal(result.priorStepsCompensated, true);
  assert.equal(JSON.parse(readFileSync(join(dir, `${result.runId}.json`), 'utf8')).failedStepMayHaveCommitted, false);
});

test('create compensation binds the ID returned in Keycloak Location', async () => {
  const calls = [];
  const dir = privateTempDir('keycloak-mcp-location-');
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_JOURNAL_DIR: dir }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (url.endsWith('/users') && options.method === 'POST') return jsonResponse(201, null, { location: 'https://id.example.com/auth/admin/realms/test-realm/users/new-user-id' });
    if (url.endsWith('/groups') && options.method === 'POST') return jsonResponse(400, {});
    return jsonResponse(204, null);
  });
  const result = await runWorkflow(admin, [
    { operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'new-user' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } },
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: {} },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.priorStepsCompensated, true);
  assert.equal(calls.at(-1), 'DELETE /auth/admin/realms/test-realm/users/new-user-id');
  const receipt = JSON.parse(readFileSync(join(dir, `${result.runId}.json`), 'utf8'));
  assert.equal(receipt.status, 'IN_DOUBT');
  assert.equal(receipt.completed[0].compensationPath['user-id'], 'new-user-id');
  assert.equal(receipt.plan[0].compensationPath['user-id'], '$step.locationId');
});

test('create compensation binds the UUID keycloak-mcp chose for a resource, returned in JSON without a Location', async () => {
  let id;
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(`${options.method} ${new URL(url).pathname}`);
    if (options.method === 'POST') {
      id = JSON.parse(options.body)._id;
      return jsonResponse(201, { _id: id, name: 'resource' });
    }
    if (options.method === 'GET') return jsonResponse(404, {});
    return jsonResponse(204, null);
  });
  const result = await runWorkflow(admin, [
    { operation: 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource',
      args: { path: { 'client-uuid': 'client-id' }, body: { name: 'resource' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource/{resource-id}',
        args: { path: { 'client-uuid': 'client-id', 'resource-id': '$step.responseId' } } } },
    { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, false);
  assert.equal(result.priorStepsCompensated, true);
  assert.equal(result.rollback[0].status, 204);
  assert.equal(calls.at(-1), `DELETE /auth/admin/realms/test-realm/clients/client-id/authz/resource-server/resource/${id}`);
});

test('JSON response binding refuses ambiguous IDs and cross-collection deletion', async () => {
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(options.method);
    return jsonResponse(201, { id: 'baebccda-a5cd-4ed8-a889-c95e4cf2d64b', _id: '498be114-4423-4f28-a1ec-8add9a250c11' });
  });
  const create = { operation: 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource',
    args: { path: { 'client-uuid': 'client-id' }, body: { name: 'resource' } } };
  const wrong = { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope/{scope-id}',
    args: { path: { 'client-uuid': 'client-id', 'scope-id': '$step.responseId' } } };
  await assert.rejects(() => runWorkflow(admin, [{ ...create, compensate: wrong }]), /compensation must target the created resource/);
  const correct = { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource/{resource-id}',
    args: { path: { 'client-uuid': 'client-id', 'resource-id': '$step.responseId' } } };
  const result = await runWorkflow(admin, [{ ...create, compensate: correct }], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(calls, ['POST']);
});

test('JSON response binding refuses a conflicting Location', async () => {
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(options.method);
    return jsonResponse(201, { _id: 'baebccda-a5cd-4ed8-a889-c95e4cf2d64b' },
      { location: 'https://id.example.com/auth/admin/realms/test-realm/clients/client-id/authz/resource-server/resource/498be114-4423-4f28-a1ec-8add9a250c11' });
  });
  const result = await runWorkflow(admin, [{
    operation: 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource',
    args: { path: { 'client-uuid': 'client-id' }, body: { name: 'resource' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource/{resource-id}',
      args: { path: { 'client-uuid': 'client-id', 'resource-id': '$step.responseId' } } },
  }], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(calls, ['POST']);
});

test('Location binding refuses a resource outside the created collection', async () => {
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(options.method);
    return jsonResponse(201, null, { location: 'https://id.example.com/auth/admin/realms/master/users/other-user' });
  });
  const result = await runWorkflow(admin, [{ operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'new-user' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } }], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(calls, ['POST']);
});

test('Location binding refuses a matching path on another origin', async () => {
  const calls = [];
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }), async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    calls.push(options.method);
    return jsonResponse(201, null, { location: 'https://other.example.com/auth/admin/realms/test-realm/users/new-user-id' });
  });
  const result = await runWorkflow(admin, [{ operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'new-user' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': '$step.locationId' } } } }], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(calls, ['POST']);
});

test('Location binding cannot direct a create compensation at another collection', async () => {
  const admin = new KeycloakAdmin(testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' }));
  await assert.rejects(() => runWorkflow(admin, [{ operation: 'POST /admin/realms/{realm}/users', args: { body: { username: 'new-user' } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } }]), /compensation must target the created resource/);
});

test('failed compensation is reported and recorded without claiming rollback', async () => {
  const dir = privateTempDir('keycloak-mcp-journal-');
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_JOURNAL_DIR: dir });
  let realmUpdates = 0;
  const admin = new KeycloakAdmin(config, async (url, options) => {
    if (url.endsWith('/token')) return tokenResponse();
    if (options.method === 'PUT' && url.endsWith('/test-realm') && ++realmUpdates === 1) return jsonResponse(204, null);
    return jsonResponse(500, {});
  });
  const result = await runWorkflow(admin, [
    { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'changed' } },
      compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'original' } } } },
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: 'test' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
  ], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.priorStepsCompensated, false);
  assert.equal(JSON.parse(readFileSync(join(dir, `${result.runId}.json`), 'utf8')).status, 'IN_DOUBT');
});

test('preflight uses the configured catalog version when no catalog is passed', () => {
  const config = testConfig({ KEYCLOAK_MCP_CATALOG_VERSION: '26.3.5' });
  assert.throws(() => preflight(config, [{ operation: 'GET /admin/realms/{realm}/workflows' }]), /not in the pinned Keycloak catalog/);
  assert.throws(() => buildRequest(config, 'GET /admin/realms/{realm}/workflows'), /not in the pinned Keycloak catalog/);
  assert.equal(buildRequest(testConfig(), 'GET /admin/realms/{realm}/workflows').op.key, 'GET /admin/realms/{realm}/workflows');
});

test('preflight and buildRequest see the configured extension catalog when no catalog is passed', () => {
  const file = writePrivateJson(join(privateTempDir('keycloak-mcp-spi-'), 'extensions.json'), { source: 'test provider',
    operations: [{ method: 'GET', path: '/realms/{realm}/sample', readOnly: true, serviceAccountSupported: true }] });
  const config = testConfig({ KEYCLOAK_MCP_EXTENSION_CATALOG: file });
  assert.equal(preflight(config, [{ operation: 'GET /realms/{realm}/sample' }])[0].operation, 'GET /realms/{realm}/sample');
  assert.equal(new URL(buildRequest(config, 'GET /realms/{realm}/sample').url).pathname, '/auth/realms/test-realm/sample');
  assert.equal(catalogFor(config), catalogFor({ ...config }), 'built once per version and extension file');
});

test('preflight reports a step without an operation before checking write permission', () => {
  assert.throws(() => preflight(testConfig(), [null]), { name: 'Error', message: 'step 1 has no operation' });
});

test('a GET or HEAD extension mutation cannot claim a compensation preflight has no rule to check', () => {
  const file = writePrivateJson(join(privateTempDir('keycloak-mcp-spi-'), 'extensions.json'), { source: 'test provider',
    operations: ['GET', 'HEAD'].map(method => ({ method, path: '/realms/{realm}/sample/rotate', readOnly: false, irreversible: false, serviceAccountSupported: true })) });
  const base = { KEYCLOAK_MCP_EXTENSION_CATALOG: file, KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
  const disableRealm = { operation: 'PUT /admin/realms/{realm}', args: { body: { enabled: false } } };
  for (const method of ['GET', 'HEAD']) {
    const operation = `${method} /realms/{realm}/sample/rotate`;
    assert.throws(() => preflight(testConfig(base), [{ operation, compensate: disableRealm }]),
      { message: `step 1 is a ${method} mutation whose compensation preflight cannot check; mark it irreversible instead` });
    const allowed = preflight(testConfig({ ...base, KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' }), [{ operation, irreversible: true }]);
    assert.equal(allowed[0].irreversible, true);
  }
});
