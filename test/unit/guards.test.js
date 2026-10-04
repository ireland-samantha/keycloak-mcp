import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromEnv, createCatalog, describeSchema, KeycloakAdmin, preflight } from '../../src/api.js';
import { buildRequest } from '../../src/http/request.js';
import { errorDetail } from '../../src/http/response.js';
import { parseToolInput, tools } from '../../src/tools/registry.js';
import { testConfig, testEnv } from '../support/config.js';
import { fakeKeycloak, jsonResponse, tokenResponse } from '../support/fetch.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

// Every guard below refuses before any request; each case pins the message a caller sees.
const refuses = (fn, message, label) => assert.throws(fn, { message }, label);
const readOnlyGet = { method: 'GET', path: '/realms/{realm}/sample', readOnly: true, serviceAccountSupported: true };
const extensionFile = content => writePrivateJson(join(privateTempDir('keycloak-mcp-spi-'), 'extensions.json'), content);

test('the extension loader refuses routes it cannot pin, classify or describe', () => {
  const cases = [
    [{ ...readOnlyGet, method: 'TRACE' }, 'invalid extension operation'],
    [{ ...readOnlyGet, path: '/realms/{realm}/{1bad}' }, 'invalid extension path parameter'],
    [{ ...readOnlyGet, readOnly: undefined }, 'extension GET must declare readOnly'],
    [{ ...readOnlyGet, serviceAccountSupported: 'yes' }, 'extension operation must declare serviceAccountSupported'],
    [{ ...readOnlyGet, query: ['ok', 'not ok'] }, 'invalid extension query'],
    [{ ...readOnlyGet, tags: [1] }, 'invalid extension tags'],
    [{ ...readOnlyGet, requestTypes: ['json'] }, 'invalid extension requestTypes'],
    [{ ...readOnlyGet, responseTypes: 'application/json' }, 'invalid extension responseTypes'],
  ];
  for (const [operation, message] of cases) refuses(() => createCatalog(extensionFile({ source: 'test', operations: [operation] })), message, JSON.stringify(operation));
  refuses(() => createCatalog(extensionFile({ operations: [readOnlyGet] })), 'invalid extension catalog');
  refuses(() => createCatalog(extensionFile({ source: 'test', operations: [{ ...readOnlyGet, path: '/admin/realms/{realm}' }] })),
    'duplicate extension operation: GET /admin/realms/{realm}');
});

test('buildRequest refuses path, content type and body combinations Keycloak would not accept', () => {
  const writer = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true' });
  const user = 'GET /admin/realms/{realm}/users/{user-id}';
  for (const value of [undefined, null, '']) refuses(() => buildRequest(writer, user, { path: { 'user-id': value } }), 'missing path parameter: user-id', String(value));
  const converter = 'POST /admin/realms/{realm}/client-description-converter';
  refuses(() => buildRequest(writer, converter, { contentType: 'application/octet-stream', body: 'x' }), 'content type is not declared for this operation');
  refuses(() => buildRequest(writer, converter, { body: 'x', bodyBase64: 'eA==' }), 'choose body or bodyBase64');
  refuses(() => buildRequest(writer, converter, { contentType: 'application/xml', body: { structured: true } }), 'non-JSON bodies require text or bodyBase64');
  refuses(() => buildRequest(writer, converter, { contentType: 'application/json', bodyBase64: 42 }), 'invalid base64 body');
  refuses(() => buildRequest(writer, 'DELETE /admin/realms/{realm}/groups/{group-id}', { path: { 'group-id': 'g' }, body: {} }), 'operation does not declare a request body');
  const invite = 'POST /admin/realms/{realm}/organizations/{org-id}/members/invite-user';
  refuses(() => buildRequest(writer, invite, { path: { 'org-id': 'o' }, body: { email: { nested: true } } }), 'form values must be scalar');
});

test('multipart bodies are refused unless they are a small map of text and base64 files', () => {
  const writer = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_MAX_BODY_BYTES: '4096' });
  const upload = 'POST /admin/realms/{realm}/identity-provider/upload-certificate';
  const file = { filename: 'idp.pem', contentType: 'application/x-pem-file', base64: 'eA==' };
  const cases = [
    [['not', 'an', 'object'], 'multipart body must be an object with at most 32 fields'],
    [Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, 'x'])), 'multipart body must be an object with at most 32 fields'],
    [{ '1bad': 'x' }, 'invalid multipart field name'],
    [{ keystoreFormat: 'x'.repeat(4096) }, 'request body exceeds configured limit'],
    [{ file: { ...file, filename: '../idp.pem' } }, 'invalid multipart filename'],
    [{ file: { ...file, contentType: 'not a type' } }, 'invalid multipart content type'],
    [{ file: 7 }, 'multipart fields must be text or a base64 file'],
  ];
  for (const [body, message] of cases) refuses(() => buildRequest(writer, upload, { body }), message, JSON.stringify(body).slice(0, 60));
  refuses(() => buildRequest(writer, upload, { contentType: 'multipart/form-data', bodyBase64: 'eA==' }), 'multipart requires structured fields');
});

test('a config file must hold a JSON object and a schema name must be a plain identifier', () => {
  refuses(() => configFromEnv({ KEYCLOAK_MCP_CONFIG: writePrivateJson(join(privateTempDir('keycloak-mcp-config-'), 'config.json'), [testEnv]) }),
    'KEYCLOAK_MCP_CONFIG must be a JSON object');
  for (const name of ['../ClientRepresentation', 'a'.repeat(129), 42]) refuses(() => describeSchema(name), 'invalid schema name', String(name));
});

test('preflight refuses a Location binding on anything but a create, and a compensation that does not mutate', () => {
  const writer = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' });
  const realmUpdate = { operation: 'PUT /admin/realms/{realm}', args: { body: {} } };
  refuses(() => preflight(writer, [{ ...realmUpdate, compensate: { ...realmUpdate, args: { ...realmUpdate.args, path: { realm: '$step.locationId' } } } }]),
    'step 1 has an invalid Location binding');
  refuses(() => preflight(writer, [{ operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': 'g' } }, irreversible: true,
    compensate: { operation: 'GET /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': 'g' } } } }]), 'step 1 compensation must mutate');
});

test('tool arguments that are not an object are refused in the MCP SDK wording', () => {
  const [search] = tools;
  assert.deepEqual(parseToolInput(search, undefined), { offset: 0, limit: 25 });
  refuses(() => parseToolInput(search, 'users'), 'Input validation error: Invalid arguments for tool keycloak_search_operations: Invalid input: expected object, received string');
});

test('Keycloak\'s error text is shown unredacted only when sensitive reads are enabled', async () => {
  const body = { error: 'invalid_key', error_description: '-----BEGIN PRIVATE KEY-----' };
  const failed = () => jsonResponse(400, body);
  assert.equal(await errorDetail(failed(), testConfig()), '[REDACTED by keycloak-mcp]');
  assert.equal(await errorDetail(failed(), testConfig({ KEYCLOAK_MCP_ALLOW_SENSITIVE_READS: 'true' })), 'invalid_key: -----BEGIN PRIVATE KEY-----');
  assert.equal(await errorDetail(new Response('{"error":', { status: 500, headers: { 'content-type': 'application/json' } }), testConfig()), '');
});

test('KeycloakAdmin.token() returns the cached service-account token', async () => {
  const admin = new KeycloakAdmin(testConfig(), fakeKeycloak(() => jsonResponse(200, {}), { token: () => tokenResponse('service-token') }));
  assert.equal(await admin.token(), 'service-token');
});
