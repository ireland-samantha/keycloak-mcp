import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatalog, describeOperation } from '../../src/api.js';
import { adminClientRouteNames, isIrreversible, isMutation, isSensitiveEndpoint } from '../../src/policy/classify.js';
import { ADMIN_CLIENT_ROUTES } from '../../src/policy/table.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

const listed = JSON.parse(readFileSync(new URL('fixtures/admin-client-only-ops.json', import.meta.url), 'utf8')).operations;
const split = key => key.match(/^(\S+) (\S+)$/).slice(1);

// When the admin-client supplement lands, each of its operations is classified by the rule its route
// matches rather than by the method defaults, so every operation the surface sweep found needs one.
test('every operation only the admin client reaches has exactly one explicit classification', () => {
  assert.equal(listed.length, 102);
  const unclassified = [];
  const ambiguous = [];
  for (const key of listed) {
    const names = adminClientRouteNames(...split(key));
    if (!names.length) unclassified.push(key);
    if (names.length > 1) ambiguous.push(`${key}: ${names.join(', ')}`);
  }
  assert.deepEqual(unclassified, []);
  assert.deepEqual(ambiguous, []);
});

test('every admin-client route rule classifies an operation the sweep found', () => {
  const used = new Set(listed.flatMap(key => adminClientRouteNames(...split(key))));
  assert.deepEqual(Object.keys(ADMIN_CLIENT_ROUTES).filter(name => !used.has(name)), []);
});

test('route rules match parameters whatever they are named, and only whole paths', () => {
  const policy = '/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/role/{policy-id}';
  assert.deepEqual(adminClientRouteNames('PUT', policy), ['authz-policy-updates']);
  assert.deepEqual(adminClientRouteNames('PUT', policy.replace('{policy-id}', '{id}')), ['authz-policy-updates']);
  assert.deepEqual(adminClientRouteNames('PUT', `${policy}/extra`), []);
  assert.deepEqual(adminClientRouteNames('POST', '/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/evaluate'), []);
  assert.deepEqual(adminClientRouteNames('GET', '/admin/realms/{realm}/clear-realm-cache'), []);
});

// Before the supplement, a private extension catalog was the only way to reach these routes, so a
// deployment may already declare them. Its declaration and the path-based sensitivity stay in force:
// a rule written for the supplement neither weakens nor overrides them.
test('an extension route that a rule matches keeps its declared classification', () => {
  const authz = '/admin/realms/{realm}/clients/{client}/authz/resource-server';
  const operations = [
    { method: 'PUT', path: `${authz}/policy/role/{policy}`, serviceAccountSupported: true, requestTypes: ['application/json'] },
    { method: 'POST', path: '/admin/realms/{realm}/clear-user-cache', irreversible: false, serviceAccountSupported: true },
    { method: 'GET', path: '/admin/realms/{realm}/users/{user}/vc/credentials', readOnly: true, serviceAccountSupported: true },
  ];
  const file = writePrivateJson(join(privateTempDir('keycloak-mcp-spi-'), 'extensions.json'), { source: 'test provider', operations });
  const catalog = createCatalog(file);
  const classified = operations.map(({ method, path }) => {
    const key = `${method} ${path}`;
    assert.equal(adminClientRouteNames(method, path).length, 1, key);
    return [key, isMutation(key, catalog), isIrreversible(key, catalog), isSensitiveEndpoint(describeOperation(key, catalog))];
  });
  assert.deepEqual(classified, [
    [`PUT ${authz}/policy/role/{policy}`, true, true, false],
    ['POST /admin/realms/{realm}/clear-user-cache', true, false, false],
    ['GET /admin/realms/{realm}/users/{user}/vc/credentials', false, false, true],
  ]);
});

test('each admin-client route rule states a consistent classification', () => {
  for (const [name, rule] of Object.entries(ADMIN_CLIENT_ROUTES)) {
    for (const flag of ['mutation', 'irreversible', 'sensitive']) assert.equal(typeof rule[flag], 'boolean', `${name} ${flag}`);
    if (!rule.mutation) assert.equal(rule.irreversible, false, name);
    if (rule.methods.includes('DELETE')) assert.equal(rule.irreversible, true, name);
  }
});
