import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest } from '../../src/http/request.js';
import { testConfig } from '../support/config.js';

const writer = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true' });
const converter = 'POST /admin/realms/{realm}/client-description-converter';
const workflows = 'POST /admin/realms/{realm}/workflows';
const smtpTest = 'POST /admin/realms/{realm}/testSMTPConnection';
const invite = 'POST /admin/realms/{realm}/organizations/{org-id}/members/invite-user';
const built = (key, args) => buildRequest(writer, key, args);

test('without contentType a text body goes as the declared text type and is sent unquoted', () => {
  const descriptor = '{"client_id":"converted"}';
  const request = built(converter, { body: descriptor });
  assert.equal(request.headers['content-type'], 'text/plain');
  assert.equal(request.body, descriptor);
  assert.equal(built(workflows, { body: 'name: wf\n' }).headers['content-type'], 'application/yaml');
});

test('without contentType a structured body goes as JSON when the operation declares it', () => {
  const request = built(workflows, { body: { name: 'wf' } });
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), { name: 'wf' });
  assert.equal(built(converter, { body: { clientId: 'x' } }).headers['content-type'], 'application/json');
  assert.equal(built(smtpTest, { body: { host: 'smtp.example.invalid' } }).headers['content-type'], 'application/json');
});

test('a body the preferred types cannot carry falls back to the first declared type', () => {
  assert.equal(built(invite, { path: { 'org-id': 'o' }, body: { email: 'a@example.invalid' } }).body, 'email=a%40example.invalid');
  assert.equal(built(workflows, { bodyBase64: Buffer.from('name: wf').toString('base64') }).headers['content-type'], 'application/yaml');
  assert.throws(() => built(invite, { path: { 'org-id': 'o' }, body: 'email=a' }), { message: 'form body must be an object' });
});

test('a form body is checked for the redaction marker as Keycloak decodes it', () => {
  const marker = '[REDACTED by keycloak-mcp]';
  const form = 'application/x-www-form-urlencoded';
  const refused = { message: /^request contains a value redacted by keycloak-mcp/ };
  assert.throws(() => built(invite, { path: { 'org-id': 'o' }, body: { email: 'a@example.invalid', firstName: marker } }), refused);
  assert.throws(() => built(invite, { path: { 'org-id': 'o' }, body: { [marker]: 'x' } }), refused);
  assert.throws(() => built(smtpTest, { contentType: form, body: { config: JSON.stringify({ host: 'smtp', password: marker }) } }), refused);
  const encoded = new URLSearchParams({ config: JSON.stringify({ password: marker }) }).toString();
  assert.throws(() => built(smtpTest, { contentType: form, bodyBase64: Buffer.from(encoded).toString('base64') }), refused);
  assert.equal(built(smtpTest, { contentType: form, body: { config: '{"host":"smtp"}' } }).body, 'config=%7B%22host%22%3A%22smtp%22%7D');
});

test('a base64 body of many megabytes is validated without exhausting the stack', () => {
  const size = 12 * 1024 * 1024;
  const config = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_MAX_BODY_BYTES: String(size) });
  const request = buildRequest(config, converter, { contentType: 'application/json', bodyBase64: Buffer.alloc(size, 0x20).toString('base64') });
  assert.equal(request.body.length, size);
  for (const bodyBase64 of ['QQ=', 'Q===', 'QQ=Q', 'QU I=', 'QUJ-']) {
    assert.throws(() => buildRequest(config, converter, { contentType: 'application/json', bodyBase64 }), { message: 'invalid base64 body' }, bodyBase64);
  }
});
