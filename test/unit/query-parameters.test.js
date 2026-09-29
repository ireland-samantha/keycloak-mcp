import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog, describeOperation } from '../../src/api.js';
import { operationParameters } from '../../src/catalog/corrections.js';
import { buildRequest } from '../../src/http/request.js';
import { catalogVersions, samplePathArgs } from '../support/catalog.js';
import { testConfig } from '../support/config.js';

const RESOURCES = 'GET /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource';
const FILTERS = ['_id', 'deep', 'exactName', 'first', 'matchingUri', 'max', 'name', 'owner', 'scope', 'type', 'uri'];
const queryNames = parameters => parameters.filter(parameter => parameter.in === 'query').map(parameter => parameter.name);
const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true' });

function query(catalog, key, name) {
  const op = describeOperation(key, catalog);
  return () => buildRequest(config, key, { path: samplePathArgs(op), query: { [name]: 'x' } }, catalog);
}

test('the bundled operation lists and the described operations name the same parameters, each once', () => {
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    for (const op of catalog.operations) {
      const described = describeOperation(op.key, catalog).parameters.map(({ name, in: location }) => `${location} ${name}`);
      assert.equal(new Set(described).size, described.length, `${version} ${op.key}`);
      assert.deepEqual(op.parameters.map(({ name, in: location }) => `${location} ${name}`), described, `${version} ${op.key}`);
    }
  }
});

test('an operation parameter replaces the path-item parameter with the same name and location', () => {
  const pathItem = { parameters: [{ name: 'realm', in: 'path' }, { name: 'max', in: 'query', schema: { type: 'string' } }, { name: 'max', in: 'header' }] };
  const operation = { parameters: [{ name: 'max', in: 'query', schema: { type: 'integer' } }] };
  assert.deepEqual(operationParameters('/admin/realms/{realm}/things', pathItem, operation),
    [{ name: 'realm', in: 'path' }, { name: 'max', in: 'header' }, { name: 'max', in: 'query', schema: { type: 'integer' } }]);
});

// surface-04: the definition hoists the collection GET's filters onto every resource path item, but
// only that GET reads them (ResourceSetService.java:391-422).
test('authorization resource filters are accepted only where Keycloak reads them', () => {
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    assert.deepEqual(queryNames(describeOperation(RESOURCES, catalog).parameters), FILTERS, version);
    assert.deepEqual(queryNames(describeOperation(`${RESOURCES}/search`, catalog).parameters), ['name'], version);
    for (const key of [`POST ${RESOURCES.slice(4)}`, `${RESOURCES}/{resource-id}`, `PUT ${RESOURCES.slice(4)}/{resource-id}`,
      `DELETE ${RESOURCES.slice(4)}/{resource-id}`, `${RESOURCES}/{resource-id}/attributes`, `${RESOURCES}/{resource-id}/scopes`,
      `${RESOURCES}/{resource-id}/permissions`]) {
      assert.deepEqual(queryNames(describeOperation(key, catalog).parameters), [], `${version} ${key}`);
      assert.throws(query(catalog, key, 'name'), /unknown query parameter: name/, `${version} ${key}`);
    }
    assert.equal(new URL(query(catalog, RESOURCES, 'name')().url).searchParams.get('name'), 'x');
  }
});

test('a path-item parameter that a sub-resource locator reads stays on its operations', () => {
  const key = 'GET /admin/realms/{realm}/clients/{client-uuid}/evaluate-scopes/scope-mappings/{roleContainerId}/granted';
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    assert.deepEqual(queryNames(describeOperation(key, catalog).parameters), ['scope'], version);
    assert.equal(new URL(query(catalog, key, 'scope')().url).searchParams.get('scope'), 'x');
  }
});
