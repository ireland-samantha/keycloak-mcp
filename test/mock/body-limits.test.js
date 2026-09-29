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

const STDIO_MESSAGE_BYTES = 10 * 1024 * 1024;
const STDIO_BODY_BYTES = 7_815_168;

test('N6 a request frame larger than the stdio buffer does not end the session', async t => {
  const { mcp, server } = await startScenario(t, { transport: 'stdio' });
  const bodyBase64 = Buffer.alloc(8 * 1024 * 1024).toString('base64');
  // The id is inside the dropped bytes, so the refusal answers no request; this call stays pending.
  const dropped = mcp.call('keycloak_read', { operation: converter, args: { contentType: 'application/json', bodyBase64 } }, { timeoutMs: 60_000 }).catch(error => error);
  for (let waited = 0; !mcp.unmatched.length && waited < 10_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(mcp.unmatched, [{ jsonrpc: '2.0', error: { code: -32600, message: `dropped an MCP message larger than ${STDIO_MESSAGE_BYTES} bytes` } }]);
  assert.equal((await mcp.listTools()).length, 5);
  assert.match(server.stderr, /^MCP transport error: dropped an MCP message larger than 10485760 bytes\n$/);
  await server.close();
  assert.match((await dropped).message, /server exited/);
});

test('N6 a body at the stdio limit arrives whole across many pipe chunks', async t => {
  const { mock, mcp } = await startScenario(t, { transport: 'stdio', settings: limit(STDIO_BODY_BYTES) });
  mock.on(`POST /admin/realms/{realm}/client-description-converter`, { json: { clientId: 'converted' } });
  const body = Buffer.alloc(STDIO_BODY_BYTES, 0x20);
  const result = await mcp.call('keycloak_read', { operation: converter, args: { contentType: 'application/json', bodyBase64: body.toString('base64') } });
  assert.equal(result.isError, false, result.text);
  assert.equal(mock.adminRequests()[0].body.length, STDIO_BODY_BYTES);
});

test('N7 a body limit that one stdio message cannot carry stops the stdio server at startup', async () => {
  const server = spawnStdioServer({ settings: { KEYCLOAK_BASE_URL: 'http://127.0.0.1:9', KEYCLOAK_REALM: 'test-realm',
    KEYCLOAK_CLIENT_ID: 'mcp-service', KEYCLOAK_CLIENT_SECRET: 'secret', ...limit(STDIO_BODY_BYTES + 1) } });
  assert.equal((await server.exited).code, 1);
  assert.equal(server.stderr, `KEYCLOAK_MCP_MAX_BODY_BYTES exceeds ${STDIO_BODY_BYTES}, the largest body one MCP stdio message can carry\n`);
});

test('N8 a result too large for one stdio message is a tool error and the session continues', async t => {
  const { mock, mcp } = await startScenario(t, { transport: 'stdio', settings: limit(STDIO_BODY_BYTES) });
  // Each backslash is two bytes of JSON and doubles again when the result text is put in a message.
  mock.on('GET /admin/realms/{realm}', { json: JSON.stringify(['\\'.repeat(3 * 1024 * 1024)]) });
  const result = await mcp.call('keycloak_read', readRealm);
  assert.equal(result.isError, true);
  assert.match(result.text, /^the result needs a \d+-byte MCP message, more than the 10485760 bytes one message can carry; request less/);
  mock.on('GET /admin/realms/{realm}', mock.fixture('realm.get'));
  assert.equal((await mcp.call('keycloak_read', readRealm)).isError, false);
});
