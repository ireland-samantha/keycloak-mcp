import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listOperations } from '../../src/api.js';

test('listOperations pages with a default size of 25 and at most 100 operations', () => {
  const first = listOperations();
  assert.equal(first.operations.length, 25);
  assert.equal(listOperations({ limit: 100 }).operations.length, 100);
  assert.deepEqual(listOperations({ offset: 25, limit: 1 }).operations, [listOperations({ limit: 26 }).operations[25]]);
  assert.equal(listOperations({ offset: first.total }).operations.length, 0);
  assert.ok(listOperations({ method: 'delete', limit: 100 }).operations.every(op => op.key.startsWith('DELETE ')));
});

test('listOperations refuses paging and filter values of the wrong type or range', () => {
  const cases = [
    [{ limit: -1 }, /^limit must be an integer from 1 to 100$/],
    [{ limit: 0 }, /^limit must be an integer from 1 to 100$/],
    [{ limit: 1000 }, /^limit must be an integer from 1 to 100$/],
    [{ limit: 2.5 }, /^limit must be an integer from 1 to 100$/],
    [{ limit: '5' }, /^limit must be an integer from 1 to 100$/],
    [{ offset: '10' }, /^offset must be a non-negative integer$/],
    [{ offset: -5 }, /^offset must be a non-negative integer$/],
    [{ search: 5 }, /^search must be a string$/],
    [{ tag: ['Users'] }, /^tag must be a string$/],
    [{ method: null }, /^method must be a string$/],
  ];
  for (const [query, message] of cases) assert.throws(() => listOperations(query), { message }, JSON.stringify(query));
});
