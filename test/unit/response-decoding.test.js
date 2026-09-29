import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResult } from '../../src/http/response.js';
import { testConfig } from '../support/config.js';

const op = { path: '/admin/realms/{realm}' };
const read = (body, contentType) => readResult(new Response(body, { status: 200, headers: { 'content-type': contentType } }), { op, config: testConfig() });

test('JSON is recognized whatever the case of its media type, and +json types are JSON too', async () => {
  for (const type of ['Application/JSON', 'APPLICATION/JSON; charset=UTF-8', 'application/problem+json']) {
    assert.deepEqual((await read('{"realm":"r"}', type)).value, { realm: 'r' }, type);
  }
});

test('text is decoded in the charset its Content-Type names, UTF-8 otherwise', async () => {
  assert.equal((await read(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=ISO-8859-1')).value, 'café');
  assert.equal((await read(Buffer.from('café'), 'TEXT/PLAIN')).value, 'café');
  assert.equal((await read(Buffer.from('café'), 'text/plain; charset=no-such-charset')).value, 'café');
});

test('a binary body keeps its normalized media type', async () => {
  assert.deepEqual((await read(Buffer.from([1, 2]), 'Application/Octet-Stream; x=1')).value, { base64: 'AQI=', contentType: 'application/octet-stream' });
});
