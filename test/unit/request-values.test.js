import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest } from '../../src/http/request.js';
import { testConfig } from '../support/config.js';

const users = 'GET /admin/realms/{realm}/users';
const user = 'GET /admin/realms/{realm}/users/{user-id}';
const query = value => new URL(buildRequest(testConfig(), users, { query: value }).url).searchParams;

test('query values are strings, numbers or booleans, a list repeats the parameter and null leaves it out', () => {
  assert.deepEqual([...query({ search: 'a b', max: 5, briefRepresentation: false, q: ['dept:eng', 'site:x'], first: null, email: undefined })],
    [['search', 'a b'], ['max', '5'], ['briefRepresentation', 'false'], ['q', 'dept:eng'], ['q', 'site:x']]);
});

test('an object, a nested list or a non-finite number is refused as a query value', () => {
  for (const value of [{ dept: 'eng' }, [[0, 1]], ['ok', { nested: true }], Number.NaN, Infinity]) {
    assert.throws(() => query({ q: value }), { message: 'query parameter q must be a string, number or boolean, or a list of them' }, JSON.stringify(value));
  }
});

test('a path value is a string or a finite number', () => {
  assert.ok(buildRequest(testConfig(), user, { path: { 'user-id': 42 } }).url.endsWith('/users/42'));
  for (const value of [{ nested: true }, ['a', 'b'], true, Number.NaN]) {
    assert.throws(() => buildRequest(testConfig(), user, { path: { 'user-id': value } }), { message: 'path parameter user-id must be a string or number' }, String(value));
  }
});
