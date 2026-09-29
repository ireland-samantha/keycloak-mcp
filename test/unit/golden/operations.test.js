import { test } from 'node:test';
import { buildRequest, createCatalog, describeOperation, isIrreversible, isMutation, listOperations } from '../../../src/keycloak.js';
import { preflight } from '../../../src/workflow.js';
import { catalogVersions, samplePathArgs } from '../../support/catalog.js';
import { testConfig } from '../../support/config.js';
import { assertSnapshot } from '../../support/snapshot.js';

const snapshot = new URL('snapshots/operations.json', import.meta.url);
const configs = {
  ro: {},
  write: { KEYCLOAK_MCP_ALLOW_WRITE: 'true' },
  writeLock: { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' },
  admin: { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' },
  adminIrr: { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_ALLOW_REALM_ADMIN: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true',
    KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' },
};

const attempt = fn => { try { return { ok: fn() }; } catch (error) { return { err: error.message }; } };
const sampleBody = type => ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'].includes(type)
  ? { sample: 'value' } : 'sample';
const request = built => ({ url: built.url, headers: built.headers,
  body: built.body instanceof FormData ? ['FormData', ...built.body.keys()] : built.body });

function operationRow(catalog, config, key) {
  const described = describeOperation(key, catalog);
  const path = samplePathArgs(described);
  const args = { path, ...(key === 'POST /admin/realms' ? { body: { realm: 'test-realm' } } : {}) };
  const row = { describe: described, mutation: isMutation(key, catalog), irreversible: isIrreversible(key, catalog), build: {}, preflight: {} };
  for (const [name, settings] of Object.entries(config)) {
    row.build[name] = attempt(() => request(buildRequest(settings, key, { path }, catalog)));
    for (const type of described.requestTypes)
      row.build[`${name}:${type}`] = attempt(() => request(buildRequest(settings, key, { path, body: sampleBody(type), contentType: type }, catalog)));
    row.preflight[name] = attempt(() => preflight(settings, [{ operation: key, args }], catalog));
    row.preflight[`${name}:irr`] = attempt(() => preflight(settings, [{ operation: key, args, irreversible: true }], catalog));
    row.preflight[`${name}:self`] = attempt(() => preflight(settings, [{ operation: key, args, compensate: { operation: key, args } }], catalog));
  }
  return row;
}

test('every operation describes, classifies, builds and preflights as the golden master records', () => {
  const golden = {};
  for (const version of catalogVersions) {
    const catalog = createCatalog('', version);
    const config = Object.fromEntries(Object.entries(configs).map(([name, overrides]) =>
      [name, testConfig({ ...overrides, KEYCLOAK_MCP_CATALOG_VERSION: version })]));
    golden[version] = { list: listOperations({ limit: 100, offset: 0 }, catalog), ops: {} };
    for (const op of catalog.operations) golden[version].ops[op.key] = operationRow(catalog, config, op.key);
  }
  assertSnapshot(snapshot, golden, { depth: 4 });
});
