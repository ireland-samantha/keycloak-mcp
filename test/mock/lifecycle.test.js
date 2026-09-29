import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnStdioServer } from '../support/mcp-stdio.js';
import { startScenario } from '../support/scenario.js';
import { assertSnapshot } from '../support/snapshot.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const secret = 'lifecycle-canary-secret';
const valid = { KEYCLOAK_BASE_URL: 'http://127.0.0.1:9', KEYCLOAK_REALM: 'test-realm', KEYCLOAK_CLIENT_ID: 'mcp-service', KEYCLOAK_CLIENT_SECRET: secret };

test('A1 initialize reports the package name and version in both protocol eras', async t => {
  for (const protocolVersion of ['2025-06-18', '2025-11-25']) {
    const server = spawnStdioServer({ settings: valid });
    t.after(() => server.close());
    const result = await server.session.initialize(protocolVersion);
    assert.deepEqual(result.serverInfo, { name: 'keycloak-mcp', version: pkg.version });
  }
});

test('A2 tools/list offers five tools, only the workflow tool destructive', async t => {
  const { mcp } = await startScenario(t, { transport: 'stdio' });
  const tools = await mcp.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['keycloak_search_operations', 'keycloak_describe_operation',
    'keycloak_describe_schema', 'keycloak_read', 'keycloak_workflow']);
  for (const tool of tools.slice(0, 4)) assert.deepEqual(tool.annotations, { readOnlyHint: true }, tool.name);
  assert.deepEqual(tools[4].annotations, { readOnlyHint: false, destructiveHint: true });
  assertSnapshot(new URL('snapshots/tools.json', import.meta.url), Object.fromEntries(tools.map(tool => [tool.name, tool])), { depth: 2 });
});

test('A3 the server answers requests and stops when stdin closes', async t => {
  const { mcp, server } = await startScenario(t, { transport: 'stdio' });
  assert.equal((await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}' })).isError, false);
  const { signal } = await server.close();
  assert.equal(signal, null, 'exited on its own, not killed after the timeout');
  assert.deepEqual(server.stdoutNoise, []);
});

test('A3 a clean shutdown exits 0 with nothing on stderr', async t => {
  const { mcp, server } = await startScenario(t, { transport: 'stdio' });
  await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}' });
  assert.deepEqual(await server.close(), { code: 0, signal: null });
  assert.equal(server.stderr, '');
});

const configErrors = [
  ['missing base URL', { ...valid, KEYCLOAK_BASE_URL: undefined }, /^KEYCLOAK_BASE_URL is required$/],
  ['plain HTTP to a non-loopback host', { ...valid, KEYCLOAK_BASE_URL: 'http://id.example.com' }, /must use HTTPS or loopback HTTP/],
  ['credentials in the base URL', { ...valid, KEYCLOAK_BASE_URL: `https://user:${secret}@id.example.com` }, /must not contain credentials/],
  ['invalid realm name', { ...valid, KEYCLOAK_REALM: '../master' }, /KEYCLOAK_REALM has invalid characters/],
  ['unsupported catalog version', { ...valid, KEYCLOAK_MCP_CATALOG_VERSION: '25.0.0' }, /unsupported KEYCLOAK_MCP_CATALOG_VERSION/],
  ['non-integer body limit', { ...valid, KEYCLOAK_MCP_MAX_BODY_BYTES: '1.5' }, /must be a positive integer/],
];

test('A4 configuration errors exit 1 with one stderr line that never shows the secret', async t => {
  const cases = [...configErrors.map(([name, settings, message]) => ({ name, settings, message })),
    { name: 'group-readable config file', settings: valid, configMode: 0o644, message: /must be a private file \(mode 0600\)/ }];
  for (const { name, settings, message, configMode } of cases) await t.test(name, async () => {
    const server = spawnStdioServer({ settings, configMode });
    const { code } = await server.exited;
    assert.equal(code, 1);
    const lines = server.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 1, server.stderr);
    assert.match(lines[0], message);
    assert.equal(server.stderr.includes(secret), false);
    assert.deepEqual(server.stdoutNoise, []);
  });
});
