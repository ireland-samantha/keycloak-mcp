import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = file => JSON.parse(readFileSync(new URL(`../validation/${file}`, import.meta.url)));
const digest = file => createHash('sha256')
  .update(readFileSync(new URL(`../validation/${file}`, import.meta.url))).digest('hex');

test('read route union is exact, source-bound, and preserves default-feature failures', () => {
  const union = read('read-coverage-26.3.5-feature-union.json');
  const base = read(union.defaultFeatureReport);
  const catalog = JSON.parse(readFileSync(new URL('../data/operations-26.3.5.json', import.meta.url)));
  assert.equal(digest(union.defaultFeatureReport), union.defaultFeatureReportSha256);
  assert.equal(base.sourceSha256, union.catalogSha256);
  assert.equal(catalog.sourceSha256, union.catalogSha256);
  assert.equal(base.total, catalog.operations.length);
  assert.equal(base.counts.OBSERVED_PASS, union.defaultFeatureSuccessful);
  assert.equal(base.counts.OBSERVED_FAIL, union.featureGatedSuccessful);
  assert.equal(base.counts.NOT_RUN_MUTATION, 185);

  const catalogKeys = new Set(catalog.operations.map(row => row.key));
  const basePasses = new Set(base.rows.filter(row => row.state === 'OBSERVED_PASS')
    .map(row => row.operation));
  const baseFailures = new Set(base.rows.filter(row => row.state === 'OBSERVED_FAIL')
    .map(row => row.operation));
  const featureKeys = union.featureGatedReads.map(row => row.operation);
  assert.equal(featureKeys.length, union.featureGatedSuccessful);
  assert.equal(new Set(featureKeys).size, featureKeys.length);
  assert.deepEqual(new Set(featureKeys), baseFailures);
  assert.ok(featureKeys.every(key => key.startsWith('GET ') && catalogKeys.has(key)));
  assert.ok(featureKeys.every(key => !basePasses.has(key)));

  for (const row of union.featureGatedReads) {
    assert.equal(digest(row.report), row.reportSha256);
    assert.match(row.scriptSha256, /^[a-f0-9]{64}$/);
    const report = read(row.report);
    assert.equal(report.catalogSha256, union.catalogSha256);
    const action = row.operation.includes('/client-secret/rotated')
      ? row.operation.replace(/^GET /, 'DELETE ')
      : row.operation.replace(/^GET /, 'PUT ');
    const supporting = report.rows.find(item => item.operation === action);
    assert.ok(supporting, `${row.operation}: no supporting action`);
    assert.ok(supporting.status >= 200 && supporting.status < 300);
    assert.equal(row.operation.includes('/client-secret/rotated')
      ? supporting.rotatedReadback : supporting.readback, true);
  }

  const readKeys = [...catalogKeys].filter(key => key.startsWith('GET ')
    && key !== union.excludedGetAction);
  assert.equal(readKeys.length, union.totalReadOnlyRoutes);
  assert.equal(basePasses.size + featureKeys.length, union.totalReadOnlyRoutes);
  assert.deepEqual(new Set([...basePasses, ...featureKeys]), new Set(readKeys));
  assert.equal(base.rows.find(row => row.operation === union.excludedGetAction).state,
    'NOT_RUN_MUTATION');
});
