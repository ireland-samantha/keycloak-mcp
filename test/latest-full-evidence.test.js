import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bytes = path => readFileSync(new URL(path, import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('26.7.4 service-account route ledger is exact and distinguishes storage-backed postcondition', () => {
  const catalog = JSON.parse(bytes('../data/operations.json'));
  const operations = new Set(catalog.operations.map(row => row.key));
  const observationsBytes = bytes('../validation/latest-26.7.4-observations.json');
  const evidence = JSON.parse(observationsBytes);
  const ledger = JSON.parse(bytes('../validation/latest-26.7.4-route-ledger.json'));
  assert.equal(catalog.operations.length, 413);
  assert.equal(evidence.catalogSha256, catalog.sourceSha256);
  assert.equal(ledger.catalogSha256, catalog.sourceSha256);
  assert.equal(ledger.observationsSha256, sha256(observationsBytes));
  assert.equal(evidence.imageDigest, 'sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c');
  // Preserve the exact source bound to the live ledger; current patches need separate validation.
  assert.equal(evidence.productSourceSha256['src/keycloak.js'], 'f15f36b52f5cca06c47440e29e53a979cf7373b1023cc8ac3c9ae4aecf244044');
  assert.equal(evidence.productSourceSha256['src/workflow.js'], 'ed3b0695ea607d59496d40bfefc768b8284de363d6d94329fdf3c109f6252c3e');
  assert.equal(evidence.postEvidenceWorkflowUpdate.currentSha256, sha256(bytes('../src/workflow.js')));
  assert.deepEqual(ledger.postEvidenceWorkflowUpdate, evidence.postEvidenceWorkflowUpdate);
  assert.equal(evidence.postEvidenceWorkflowUpdate.cycleReportSha256,
    sha256(bytes(`../validation/${evidence.postEvidenceWorkflowUpdate.cycleReport}`)));
  for (const hash of Object.values(evidence.privateEvidenceArchiveSha256)) assert.match(hash, /^[a-f0-9]{64}$/);

  const observed = new Map();
  const defaultObserved = new Set();
  const sourceNames = new Set();
  for (const source of evidence.sources) {
    assert.match(source.name, /^(?:default|explicit-features|storage-backed)\/[A-Za-z0-9.-]+\.json$/);
    assert.equal(sourceNames.has(source.name), false);
    sourceNames.add(source.name);
    assert.match(source.rawSha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(source.rows));
    for (const row of source.rows) {
      assert.ok(operations.has(row.operation), row.operation);
      assert.ok(row.status === null || Number.isInteger(row.status));
      if (!Number.isInteger(row.status) || row.status < 200 || row.status >= 300 ||
        ![undefined, 'OBSERVED_PASS'].includes(row.state) || row.readback === false ||
        ![undefined, 'COMPLETED', 'IN_DOUBT'].includes(row.workflowStatus)) continue;
      const current = observed.get(row.operation) ?? [];
      current.push({ source: source.name, status: row.status });
      observed.set(row.operation, current);
      if (source.name.startsWith('default/')) defaultObserved.add(row.operation);
    }
  }
  assert.equal(sourceNames.size, 49);
  assert.equal(defaultObserved.size, 393);
  assert.equal(observed.size, 413);
  assert.equal(ledger.total, 413);
  assert.equal(ledger.observedCount, 413);
  assert.equal(ledger.missingCount, 0);
  assert.deepEqual(new Set(ledger.rows.map(row => row.operation)), operations);
  assert.equal(ledger.rows.length, operations.size);
  for (const row of ledger.rows) {
    assert.equal(row.observed, observed.has(row.operation), row.operation);
    assert.deepEqual(row.observations, observed.get(row.operation) ?? [], row.operation);
  }
  const missing = ledger.rows.filter(row => !row.observed).map(row => row.operation);
  assert.deepEqual(missing, []);
  const credentialOperation = 'PUT /admin/realms/{realm}/users/{user-id}/disable-credential-types';
  const credentialSource = evidence.sources.find(source => source.name === 'default/final-credentials.json');
  const ineffective = credentialSource.rows.find(row => row.operation === credentialOperation);
  assert.equal(ineffective.status, 204);
  assert.equal(ineffective.readback, false);
  const storageSource = evidence.sources.find(source => source.name === 'storage-backed/storage-disable.json');
  const effective = storageSource.rows.find(row => row.operation === credentialOperation);
  assert.equal(effective.status, 204);
  assert.equal(effective.readback, true);
  assert.deepEqual(ledger.rows.find(row => row.operation === credentialOperation).observations,
    [{ source: 'storage-backed/storage-disable.json', status: 204 }]);
  assert.equal(ledger.cleanup.default.testRealmAbsentRead, 404);
  assert.equal(ledger.cleanup.default.masterServiceClientAbsentRead, true);
  assert.equal(ledger.cleanup.explicitFeatures.realmAbsentRead, 404);
  assert.equal(ledger.cleanup.storageBacked.realmAbsentRead, 404);
});
