import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnStdioServer } from '../support/mcp-stdio.js';
import { assertRefusedOffline, startScenario, WRITER } from '../support/scenario.js';
import { createStep, readRealm } from '../support/steps.js';

const limit = bytes => ({ KEYCLOAK_MCP_MAX_BODY_BYTES: String(bytes) });
const converter = 'POST /admin/realms/{realm}/client-description-converter';

async function refusedOffline(mcp, mock, tool, args) {
  assertRefusedOffline(mock, await mcp.call(tool, args), /^request body exceeds configured limit$/);
}

test('N1 a request body over the limit is refused before any request', async t => {
  const { mock, mcp } = await startScenario(t, { settings: { ...WRITER, ...limit(1024) } });
  await refusedOffline(mcp, mock, 'keycloak_read', { operation: converter, args: { contentType: 'text/plain', body: 'x'.repeat(2048) } });
  await refusedOffline(mcp, mock, 'keycloak_workflow', { execute: true, steps: [createStep('groups', 'group-id', { name: 'x'.repeat(2048) })] });
});

test('N2 a response whose Content-Length exceeds the limit is refused before its body is read', async t => {
  const { mock, mcp } = await startScenario(t, { settings: limit(1024) });
  // No body byte is ever sent, so only the Content-Length header can produce this answer;
  // the streaming check (N3) would wait for body bytes that never come.
  mock.on('GET /admin/realms/{realm}', { headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024) }, hold: true });
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.text, 'response exceeds configured limit (HTTP 200)');
  const [request] = mock.adminRequests();
  await request.settled;
  assert.equal(request.closedEarly, true);
});

test('N3 a chunked response over the limit is cut off while streaming', async t => {
  const { mock, mcp } = await startScenario(t, { settings: limit(64 * 1024) });
  mock.on('GET /admin/realms/{realm}', { headers: { 'content-type': 'application/json' }, stream: { chunks: 64, chunkBytes: 16 * 1024, intervalMs: 5 } });
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.text, 'response exceeds configured limit (HTTP 200)');
  const [request] = mock.adminRequests();
  await request.settled;
  assert.equal(request.closedEarly, true);
});

test('N4 oversized base64 and multipart files are refused before decoding or sending', async t => {
  const { mock, mcp } = await startScenario(t, { settings: limit(4096) });
  const oversized = Buffer.alloc(8192).toString('base64');
  await refusedOffline(mcp, mock, 'keycloak_read', { operation: converter, args: { contentType: 'application/json', bodyBase64: oversized } });
  await refusedOffline(mcp, mock, 'keycloak_read', { operation: 'POST /admin/realms/{realm}/identity-provider/upload-certificate',
    args: { body: { keystoreFormat: 'Certificate PEM', file: { filename: 'idp.pem', contentType: 'application/x-pem-file', base64: oversized } } } });
});

test('N5 body limits above 64 MiB or not an integer stop the server at startup', async t => {
  for (const value of ['67108865', '1e6', '-1']) await t.test(value, async () => {
    const server = spawnStdioServer({ settings: { KEYCLOAK_BASE_URL: 'http://127.0.0.1:9', KEYCLOAK_REALM: 'test-realm',
      KEYCLOAK_CLIENT_ID: 'mcp-service', KEYCLOAK_CLIENT_SECRET: 'secret', ...limit(value) } });
    assert.equal((await server.exited).code, 1);
    assert.match(server.stderr, /^KEYCLOAK_MCP_MAX_BODY_BYTES (?:exceeds 64 MiB|must be a positive integer)\n$/);
  });
});

test('N6 a request frame larger than the stdio buffer does not end the session', { todo: 'MCPLIVE-07' }, async t => {
  const { mcp } = await startScenario(t, { transport: 'stdio', settings: limit(16 * 1024 * 1024) });
  const bodyBase64 = Buffer.alloc(8 * 1024 * 1024).toString('base64');
  await mcp.call('keycloak_read', { operation: converter, args: { contentType: 'application/json', bodyBase64 } }, { timeoutMs: 10_000 }).catch(() => {});
  assert.equal((await mcp.listTools()).length, 5);
});
