import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLosslessJson } from '../../src/internal/json.js';
import { readResult } from '../../src/http/response.js';
import { testConfig } from '../support/config.js';

const exact = '{"eventsExpiration":9007199254740993,"big":12345678901234567890,"ratio":1.0,"hundred":1e2,"negativeZero":-0,"list":[1.50,2]}';

test('numbers JSON.parse would change keep their source text through a parse and stringify', () => {
  assert.equal(JSON.stringify(parseLosslessJson(exact)), exact);
});

test('numbers that print back as their source stay plain numbers', () => {
  const value = parseLosslessJson('{"count":42,"fraction":0.1,"negative":-7,"nested":{"max":100}}');
  assert.deepEqual(value, { count: 42, fraction: 0.1, negative: -7, nested: { max: 100 } });
});

test('a JSON response keeps exact numbers through redaction and serialization', async () => {
  const response = new Response(`{"secret":"hidden","expiration":9007199254740993}`, { headers: { 'content-type': 'application/json' } });
  const result = await readResult(response, { op: { path: '/admin/realms/{realm}' }, config: testConfig() });
  assert.match(JSON.stringify(result.value), /"expiration":9007199254740993/);
});
