import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatalog, describeOperation } from '../../src/api.js';
import { buildRequest } from '../../src/http/request.js';
import { pathParameterNames } from '../../src/internal/path-template.js';
import { catalogVersions } from '../support/catalog.js';
import { testConfig } from '../support/config.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

test('no bundled operation names a path parameter twice', () => {
  for (const version of catalogVersions) {
    for (const op of createCatalog('', version).operations) {
      const names = pathParameterNames(op.path);
      assert.equal(new Set(names).size, names.length, `${version} ${op.key}`);
    }
  }
});

test('26.3.5 addresses the role\'s client and the composite\'s client separately, as HEAD does', () => {
  const catalog = createCatalog('', '26.3.5');
  const key = 'GET /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}/composites/clients/{targetClientUuid}';
  assert.equal(catalog.byKey.has('GET /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}/composites/clients/{client-uuid}'), false);
  assert.ok(createCatalog('', 'latest').byKey.has(key), 'the key latest uses');
  assert.deepEqual(describeOperation(key, catalog).parameters.filter(parameter => parameter.in === 'path').map(parameter => parameter.name),
    ['realm', 'client-uuid', 'role-name', 'targetClientUuid']);
  const request = buildRequest(testConfig({ KEYCLOAK_MCP_CATALOG_VERSION: '26.3.5' }), key,
    { path: { 'client-uuid': 'owner', 'role-name': 'composite', targetClientUuid: 'target' } }, catalog);
  assert.equal(new URL(request.url).pathname, '/auth/admin/realms/test-realm/clients/owner/roles/composite/composites/clients/target');
});

test('an extension route that names a path parameter twice is refused', () => {
  const file = writePrivateJson(join(privateTempDir('keycloak-mcp-spi-'), 'extensions.json'), { source: 'test provider',
    operations: [{ method: 'GET', path: '/realms/{realm}/items/{id}/links/{id}', readOnly: true, serviceAccountSupported: true }] });
  assert.throws(() => createCatalog(file), { message: 'invalid extension path parameter' });
});
