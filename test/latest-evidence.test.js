import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bytes = path => readFileSync(new URL(path, import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('all 41 latest-only routes have source-bound 26.7.4 service-account observations', () => {
  const union = JSON.parse(bytes('../validation/latest-only-26.7.4-union.json'));
  const latest = JSON.parse(bytes('../data/operations.json'));
  const deployed = JSON.parse(bytes('../data/operations-26.3.5.json'));
  assert.equal(union.latestCatalogSha256, latest.sourceSha256);
  assert.equal(union.deployedCatalogSha256, deployed.sourceSha256);
  // The live route observations belong to the published source before later hardening.
  assert.equal(union.productSourceSha256['src/keycloak.js'], 'f15f36b52f5cca06c47440e29e53a979cf7373b1023cc8ac3c9ae4aecf244044');
  assert.equal(union.productSourceSha256['src/workflow.js'], 'ed3b0695ea607d59496d40bfefc768b8284de363d6d94329fdf3c109f6252c3e');
  assert.equal(union.postEvidenceWorkflowUpdate.currentSha256, sha256(bytes('../src/workflow.js')));
  const cycleBytes = bytes(`../validation/${union.postEvidenceWorkflowUpdate.cycleReport}`);
  assert.equal(union.postEvidenceWorkflowUpdate.cycleReportSha256, sha256(cycleBytes));
  const cycle = JSON.parse(cycleBytes);
  assert.equal(cycle.workflowSourceSha256, union.postEvidenceWorkflowUpdate.currentSha256);
  assert.equal(cycle.keycloakSourceSha256, union.productSourceSha256['src/keycloak.js']);
  assert.equal(cycle.preflight, 'PREFLIGHT_OK');
  assert.equal(cycle.createStatus, 201);
  assert.equal(cycle.forcedReadFailure, 404);
  assert.equal(cycle.rollbackStatus, 204);
  assert.equal(cycle.result, 'IN_DOUBT');
  assert.equal(cycle.failedReadMayHaveCommitted, false);
  assert.equal(cycle.priorStepsCompensated, true);
  assert.equal(cycle.exactNameCountBefore, 0);
  assert.equal(cycle.exactNameCountAfter, 0);
  assert.notEqual(union.historicalProductSourceSha256['src/keycloak.js'], union.productSourceSha256['src/keycloak.js']);
  assert.match(union.currentSourceRerun, /seven fixture scripts reran/);
  const latestOnly = new Set(latest.operations.map(row => row.key));
  for (const row of deployed.operations) latestOnly.delete(row.key);
  assert.equal(latestOnly.size, 41);
  assert.equal(union.latestOnlyCount, latestOnly.size);
  assert.deepEqual(union.methodCounts, { DELETE: 6, GET: 22, POST: 10, PUT: 3 });
  assert.deepEqual(new Set(union.rows.map(row => row.operation)), latestOnly);
  assert.equal(union.rows.length, latestOnly.size);

  const reports = new Map();
  for (const source of union.sources) {
    const raw = bytes(`../validation/${source.file}`);
    assert.equal(sha256(raw), source.sha256);
    assert.match(source.scriptSha256, /^[a-f0-9]{64}$/);
    assert.match(source.currentRerunScriptSha256, /^[a-f0-9]{64}$/);
    const report = JSON.parse(raw);
    assert.equal(report.catalogVersion, 'latest');
    assert.equal(report.catalogSha256, latest.sourceSha256);
    assert.equal(report.imageDigest, union.imageDigest);
    assert.equal(report.fixturesRemoved ?? report.fixtureRemoved ?? !report.fixturePersisted, true);
    reports.set(source.file, report);
  }
  assert.equal(reports.size, 7);

  for (const row of union.rows) {
    assert.ok(row.observations.length > 0, row.operation);
    for (const observation of row.observations) {
      assert.ok(observation.status >= 200 && observation.status < 300, row.operation);
      const report = reports.get(observation.report);
      assert.ok(report, row.operation);
      const matching = report.rows.some(raw => raw.operation === row.operation
        && Object.entries(observation).every(([key, value]) => key === 'report' ||
          JSON.stringify(raw[key]) === JSON.stringify(value)));
      assert.equal(matching, true, row.operation);
    }
  }
  const invitation = reports.get('latest-26.7.4-invitation-probe.json');
  assert.equal(invitation.smtpRestored, true);
  const certificate = reports.get('latest-26.7.4-idp-certificate-probe.json').rows[0];
  assert.equal(certificate.productWritesDisabled, true);
  assert.equal(certificate.publicKeyReturned, true);
  assert.equal(certificate.privateKeyReturned, false);
  const cleanup = JSON.parse(bytes('../validation/latest-26.7.4-cleanup.json'));
  assert.equal(cleanup.organizationsCount, 0);
  assert.equal(cleanup.workflowListEmpty, true);
  assert.equal(cleanup.realmDelete, 204);
  assert.equal(cleanup.realmAbsentRead, 404);
  assert.equal(cleanup.containersAbsent, true);
  assert.equal(cleanup.remoteProofTempAbsent, true);
  assert.equal(cleanup.testPortClosed, true);
});
