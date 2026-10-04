import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatalog } from '../../src/api.js';
import { buildRequest } from '../../src/http/request.js';
import { testConfig } from '../support/config.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

const extensionWith = path => writePrivateJson(join(privateTempDir('keycloak-mcp-spi-'), 'extensions.json'),
  { source: 'test provider', operations: [{ method: 'GET', path, readOnly: true, serviceAccountSupported: true }] });

test('an extension path with whitespace or a control character is refused when the catalog loads', () => {
  for (const hidden of ['\t', '\n', '\r', ' ', '\u0000', '\u007f', ' ']) {
    const path = `/realms/{realm}/.${hidden}./.${hidden}./admin/realms/other-realm/users`;
    assert.throws(() => createCatalog(extensionWith(path)), { message: 'invalid extension operation' }, JSON.stringify(hidden));
  }
  assert.equal(createCatalog(extensionWith('/realms/{realm}/sample/{id}')).extensionCount, 1);
});

test('buildRequest refuses a path that the URL parser would rewrite', () => {
  // A catalog assembled by hand, bypassing the extension loader's checks, to reach the final guard.
  const op = { key: 'GET /realms/{realm}/./sample', method: 'GET', path: '/realms/{realm}/./sample', parameters: [], requestTypes: [],
    responseTypes: [], extension: true, readOnly: true, serviceAccountSupported: true };
  const catalog = { operations: [op], byKey: new Map([[op.key, op]]) };
  assert.throws(() => buildRequest(testConfig(), op.key, {}, catalog), { message: 'unsafe request path' });
  const tabbed = { ...op, key: 'GET /realms/{realm}/sam\tple', path: '/realms/{realm}/sam\tple' };
  assert.throws(() => buildRequest(testConfig(), tabbed.key, {}, { operations: [tabbed], byKey: new Map([[tabbed.key, tabbed]]) }), { message: 'unsafe request path' });
});

test('the path check holds for a base URL with and without a path of its own', () => {
  for (const base of ['https://id.example.com', 'https://id.example.com/', 'https://id.example.com/auth/']) {
    const request = buildRequest(testConfig({ KEYCLOAK_BASE_URL: base }), 'GET /admin/realms/{realm}/users/{user-id}', { path: { 'user-id': 'a/b' } });
    assert.equal(new URL(request.url).pathname.endsWith('/admin/realms/test-realm/users/a%2Fb'), true, base);
  }
});
