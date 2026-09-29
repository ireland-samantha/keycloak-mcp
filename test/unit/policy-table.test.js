import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUEST_BODY_CORRECTIONS } from '../../src/catalog/corrections.js';
import { createCatalog } from '../../src/catalog/index.js';
import * as table from '../../src/policy/table.js';
import { catalogVersions } from '../support/catalog.js';

// A table export is either one rule or a list or map of rules.
const rules = Object.entries(table).flatMap(([name, value]) => ('reason' in value ? [[name, value]]
  : Object.entries(value).map(([key, rule]) => [`${name} ${key}`, rule])));

test('every policy and catalog-correction rule states its reason and the Keycloak source behind it', () => {
  const all = [...rules, ...REQUEST_BODY_CORRECTIONS.map((rule, index) => [`REQUEST_BODY_CORRECTIONS ${index}`, rule])];
  assert.ok(all.length > 30, `${all.length} rules`);
  for (const [name, rule] of all) {
    assert.ok(typeof rule.reason === 'string' && rule.reason.length > 10, `${name} reason`);
    assert.match(rule.source, /\.java:\d+/, `${name} source`);
  }
});

test('every operation key the policy names exists in a bundled catalog', () => {
  const known = new Set(catalogVersions.flatMap(version => createCatalog('', version).operations.map(op => op.key)));
  const keys = [...Object.keys(table.OPERATION_OVERRIDES), ...Object.keys(table.NAMED_CREATE_TARGETS),
    table.REALM_CREATION.operation, table.REALM_CREATION.compensation,
    ...table.TOKEN_REFRESH_BEFORE_COMPENSATION.flatMap(pair => [pair.operation, pair.compensation]),
    ...REQUEST_BODY_CORRECTIONS.flatMap(rule => rule.keys)];
  for (const key of keys) assert.ok(known.has(key), key);
});
