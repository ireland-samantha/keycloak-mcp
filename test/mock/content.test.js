import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScenario } from '../support/scenario.js';
import { readRealm } from '../support/steps.js';

const workflows = 'GET /admin/realms/{realm}/workflows';

async function readWith(t, response, call = readRealm) {
  const { mock, mcp } = await startScenario(t);
  mock.on(call.operation, response);
  return { mock, result: await mcp.call('keycloak_read', call) };
}

test('O1 JSON is parsed and reported with its media type; an empty 204 has no value', async t => {
  assert.deepEqual((await readWith(t, { json: { realm: 'test-realm' } })).result.value, { status: 200, contentType: 'application/json', value: { realm: 'test-realm' } });
  assert.deepEqual((await readWith(t, { status: 204 })).result.value, { status: 204 });
});

test('O2 text, XML and YAML bodies are returned as strings', async t => {
  for (const type of ['text/plain', 'application/xml', 'application/yaml;charset=UTF-8']) {
    const { result } = await readWith(t, { headers: { 'content-type': type }, body: 'plain body' });
    assert.equal(result.value.value, 'plain body', type);
  }
});

test('O3 other media types are returned as base64 with their content type', async t => {
  const { result } = await readWith(t, { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2]) });
  assert.deepEqual(result.value.value, { base64: 'AAEC', contentType: 'application/octet-stream' });
});

test('O4 a malformed JSON body is an error', async t => {
  const { result } = await readWith(t, { headers: { 'content-type': 'application/json' }, body: '{"realm":' });
  assert.equal(result.text, 'Keycloak returned invalid JSON');
});

test('O5 accept selects a declared response type; an undeclared one is refused before any request', async t => {
  const { mock, mcp } = await startScenario(t);
  const yaml = await mcp.call('keycloak_read', { operation: workflows, args: { accept: 'application/yaml' } });
  assert.equal(yaml.value.value, mock.fixture('workflows.default').body);
  assert.equal(mock.adminRequests()[0].headers.accept, 'application/yaml');
  const refused = await mcp.call('keycloak_read', { operation: workflows, args: { accept: 'text/csv' } });
  assert.equal(refused.text, 'accept type is not declared for this operation');
  assert.equal(mock.adminRequests().length, 1);
});

test('O5 without accept, an operation that can answer JSON is read as JSON', async t => {
  const { mock, mcp } = await startScenario(t);
  const result = await mcp.call('keycloak_read', { operation: workflows });
  assert.deepEqual(result.value.value, []);
  assert.equal(mock.adminRequests()[0].headers.accept, 'application/json');
});

test('O5 an operation that declares no JSON response is sent no Accept header of its own', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('GET /admin/realms/{realm}/localization/{locale}/{key}', { headers: { 'content-type': 'text/plain' }, body: 'Welcome' });
  const result = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/localization/{locale}/{key}', args: { path: { locale: 'en', key: 'welcome' } } });
  assert.equal(result.value.value, 'Welcome');
  assert.notEqual(mock.adminRequests()[0].headers.accept, 'application/json');
});

test('O6 request bodies are encoded as their declared content type', async t => {
  const { mock, mcp } = await startScenario(t);
  mock.on('POST /admin/realms/{realm}/client-description-converter', { json: { clientId: 'converted' } });
  await mcp.call('keycloak_read', { operation: 'POST /admin/realms/{realm}/client-description-converter',
    args: { contentType: 'text/plain', body: '<EntityDescriptor/>' } });
  const [request] = mock.adminRequests();
  assert.equal(request.headers['content-type'], 'text/plain');
  assert.equal(request.text(), '<EntityDescriptor/>');
});

test('O7 a Location header on a read result is surfaced', async t => {
  const { mock, result } = await readWith(t, (request, keycloak) => ({ json: {}, headers: { location: keycloak.location('/elsewhere') } }));
  assert.equal(result.value.location, mock.location('/elsewhere'));
});

test('O8 integers beyond 2^53 and number spelling survive the read', async t => {
  const { result } = await readWith(t, { json: '{"eventsExpiration":9007199254740993,"ratio":1.0}' },
    { operation: 'GET /admin/realms/{realm}/events/config' });
  assert.match(result.text, /"eventsExpiration":9007199254740993/);
  assert.match(result.text, /"ratio":1\.0/);
});

test('O9 a failed read carries the error Keycloak sent', { todo: 'MCPLIVE-05' }, async t => {
  const { mcp } = await startScenario(t);
  const result = await mcp.call('keycloak_read', { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } });
  assert.equal(result.isError, true);
  assert.match(result.text, /User not found/);
});

test('O10 an empty body and a JSON null are distinguishable', async t => {
  const empty = (await readWith(t, { status: 200, headers: { 'content-type': 'application/json' } })).result;
  const nothing = (await readWith(t, { json: 'null' })).result;
  assert.notEqual(empty.text, nothing.text);
  assert.deepEqual([empty.value, nothing.value], [{ status: 200 }, { status: 200, contentType: 'application/json', value: null }]);
});
