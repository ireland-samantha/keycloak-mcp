import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBundled } from '../../src/catalog/bundled.js';
import { correctionForDefinitionPath } from '../../src/catalog/corrections.js';
import { createCatalog, listOperations, openApiCatalog } from '../../src/catalog/index.js';
import { loadSupplement } from '../../src/catalog/supplement.js';
import { catalogVersions } from '../support/catalog.js';

// The one place that states how many operations each bundled definition has. `npm run catalog:update`
// changes them on purpose: review the catalog diff, then update this table in the same commit.
const OPENAPI_OPERATIONS = { latest: 413, '26.3.5': 374, nightly: 415 };
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

// Operation keys of a bundled OpenAPI definition, with any path-parameter correction applied.
function definitionKeys(version) {
  const { paths } = loadBundled(version).openapi;
  return Object.entries(paths).flatMap(([path, item]) => Object.keys(item).filter(method => METHODS.includes(method))
    .map(method => `${method.toUpperCase()} ${correctionForDefinitionPath(version, path)?.path ?? path}`)).sort();
}

test('the contract covers every bundled catalog version', () => {
  assert.deepEqual(Object.keys(OPENAPI_OPERATIONS).sort(), [...catalogVersions].sort());
});

for (const version of catalogVersions) {
  test(`the ${version} catalog lists each operation of its bundled definition once, plus its supplement`, () => {
    const keys = definitionKeys(version);
    assert.equal(keys.length, OPENAPI_OPERATIONS[version], `${version}: the definition changed; review it and update OPENAPI_OPERATIONS`);
    assert.deepEqual(openApiCatalog(version).operations.map(op => op.key).sort(), keys);
    const catalog = createCatalog('', version);
    const supplement = loadSupplement(version);
    assert.equal(catalog.operations.length, keys.length + (supplement?.operations.length ?? 0));
    assert.equal(new Set(catalog.operations.map(op => op.key)).size, catalog.operations.length);
    assert.equal(listOperations({ limit: 1 }, catalog).total, catalog.operations.length);
    assert.match(catalog.sourceSha256, /^[0-9a-f]{64}$/);
  });
}

// DESIGN §3: the supplement lists what the admin client has and this very definition lacks.
test('a bundled admin-client supplement was generated against the bundled definition', () => {
  for (const version of catalogVersions) {
    const supplement = loadSupplement(version);
    if (supplement) assert.equal(supplement.openapiSha256, createCatalog('', version).sourceSha256, `${version}: regenerate the supplement`);
  }
});
