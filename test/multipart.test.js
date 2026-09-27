import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequest, configFromEnv, createCatalog, describeOperation, isMutation } from '../src/keycloak.js';

const env = {
  KEYCLOAK_BASE_URL: 'https://id.example.com', KEYCLOAK_REALM: 'test',
  KEYCLOAK_CLIENT_ID: 'service-client', KEYCLOAK_CLIENT_SECRET: 'secret',
  KEYCLOAK_MCP_ALLOW_WRITE: 'true',
};
const upload = 'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/upload-certificate';

test('certificate uploads serialize a bounded multipart form on both pinned catalogs', async () => {
  for (const version of ['latest', '26.3.5']) {
    const catalog = createCatalog('', version);
    assert.ok(describeOperation(upload, catalog).requestTypes.includes('multipart/form-data'));
    const request = buildRequest(configFromEnv(env), upload, { path: {
      'client-uuid': 'client-id', attr: 'jwt.credential',
    }, contentType: 'multipart/form-data', body: {
      keystoreFormat: 'Certificate PEM',
      file: { filename: 'test.pem', contentType: 'application/x-pem-file',
        base64: Buffer.from('-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n').toString('base64') },
    } }, catalog);
    assert.ok(request.body instanceof FormData);
    assert.equal(request.headers['content-type'], undefined);
    assert.equal(request.body.get('keystoreFormat'), 'Certificate PEM');
    assert.equal(request.body.get('file').name, 'test.pem');
    assert.equal(await request.body.get('file').text(), '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');
  }
});

test('multipart validation rejects malformed files and oversized bodies before network', () => {
  const catalog = createCatalog('', '26.3.5');
  const path = { 'client-uuid': 'client-id', attr: 'jwt.credential' };
  const config = configFromEnv(env);
  assert.throws(() => buildRequest(config, upload, { path, contentType: 'multipart/form-data',
    body: { file: { filename: '../escape.pem', contentType: 'application/x-pem-file', base64: 'Zm9v' } } }, catalog), /filename/);
  assert.throws(() => buildRequest(config, upload, { path, contentType: 'multipart/form-data',
    body: { file: { filename: 'test.pem', contentType: 'application/x-pem-file', base64: 'not-base64' } } }, catalog), /base64/);
  assert.throws(() => buildRequest(configFromEnv({ ...env, KEYCLOAK_MCP_MAX_BODY_BYTES: '100' }), upload,
    { path, contentType: 'multipart/form-data', body: { keystoreFormat: 'Certificate PEM' } }, catalog), /limit/);
});

test('oversized base64 input is rejected before decoding into a request body', () => {
  const config = configFromEnv({ ...env, KEYCLOAK_MCP_MAX_BODY_BYTES: '4096' });
  const oversized = Buffer.alloc(8192).toString('base64');
  const originalFrom = Buffer.from;
  let decoded = false;
  Buffer.from = function (value, encoding, ...rest) {
    if (value === oversized && encoding === 'base64') decoded = true;
    return originalFrom.call(this, value, encoding, ...rest);
  };
  try {
    assert.throws(() => buildRequest(config, upload, { path: {
      'client-uuid': 'client-id', attr: 'jwt.credential',
    }, contentType: 'multipart/form-data', body: {
      file: { filename: 'test.pem', contentType: 'application/x-pem-file', base64: oversized },
    } }), /request body exceeds configured limit/);
    assert.throws(() => buildRequest(config, 'POST /admin/realms/{realm}/client-description-converter',
      { bodyBase64: oversized, contentType: 'application/json' }), /request body exceeds configured limit/);
    assert.equal(decoded, false);
  } finally { Buffer.from = originalFrom; }
});

test('latest identity-provider certificate upload is a bounded read-only multipart conversion', async () => {
  const operation = 'POST /admin/realms/{realm}/identity-provider/upload-certificate';
  const catalog = createCatalog('', 'latest');
  const config = configFromEnv({ ...env, KEYCLOAK_MCP_ALLOW_WRITE: 'false' });
  assert.equal(isMutation(operation, catalog), false);
  assert.deepEqual(describeOperation(operation, catalog).requestTypes, ['multipart/form-data']);
  const request = buildRequest(config, operation, { body: {
    keystoreFormat: 'Certificate PEM',
    file: { filename: 'idp.pem', contentType: 'application/x-pem-file',
      base64: Buffer.from('fixture public certificate').toString('base64') },
  } }, catalog);
  assert.ok(request.body instanceof FormData);
  assert.equal(request.headers['content-type'], undefined);
  assert.equal(await request.body.get('file').text(), 'fixture public certificate');
});
