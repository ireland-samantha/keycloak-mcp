import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const reports = [
  ['feature-gated-client-types-26.3.5-isolated.json', 'eb172bc4975a3f1ad212a848b7c6826ef3533ddc9ee038d80738e14d32d707d2'],
  ['feature-gated-fgap-v1-users-26.3.5-isolated.json', '2868a7a3c05a0046c9fc3452afc50fa7b5b5bb60c1a07d290ce87c333be2ae15'],
  ['feature-gated-fgap-v1-resources-26.3.5-isolated.json', '461d27a2c44b65198255adf056a9847abffd7ce7ca1dd1fe90f9862bba1b5cbe'],
];

test('feature-gated Keycloak 26.3.5 reports retain eight distinct readback-verified actions', () => {
  const all = [];
  for (const [file, digest] of reports) {
    const bytes = readFileSync(new URL(`../validation/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    const report = JSON.parse(bytes);
    assert.equal(report.catalogVersion, '26.3.5');
    assert.equal(report.catalogSha256, 'c13a159f13ddaf20f11d4c7f93511589461f4779893941e8446809253e2300d5');
    assert.match(report.configuration, /client-types|admin-fine-grained-authz:v1/);
    assert.equal(report.restored ?? report.fixturesRemoved, true);
    assert.ok(report.rows.every(row => row.status >= 200 && row.status < 300 && row.readback === true));
    all.push(...report.rows.map(row => row.operation));
  }
  assert.equal(all.length, 8);
  assert.equal(new Set(all).size, 8);
  assert.ok(all.includes('PUT /admin/realms/{realm}/client-types'));
  assert.ok(all.includes('PUT /admin/realms/{realm}/users-management-permissions'));
  assert.equal(all.filter(operation => operation.endsWith('/management/permissions')).length, 6);
});

test('isolated impersonation and rotated-secret reports retain distinct success limits', () => {
  const cases = [
    ['isolated-impersonation-26.3.5.json',
      'c1e9fe98ced76b05a32f256168f6852184bd5e43b5f21ea51a70c3ee99df643e',
      'POST /admin/realms/{realm}/users/{user-id}/impersonation', 200],
    ['feature-gated-rotated-secret-26.3.5-isolated.json',
      '47c2107be9497f6e916083504c0ab26d3332885a4cf5cdb1b03ec829016b94c1',
      'DELETE /admin/realms/{realm}/clients/{client-uuid}/client-secret/rotated', 204],
  ];
  for (const [file, digest, operation, status] of cases) {
    const bytes = readFileSync(new URL(`../validation/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    const report = JSON.parse(bytes);
    assert.equal(report.catalogVersion, '26.3.5');
    assert.equal(report.catalogSha256, 'c13a159f13ddaf20f11d4c7f93511589461f4779893941e8446809253e2300d5');
    assert.equal(report.fixtureRemoved ?? report.fixturesRemoved, true);
    assert.deepEqual(report.rows.map(row => [row.operation, row.status]), [[operation, status]]);
  }
  const rotated = JSON.parse(readFileSync(new URL('../validation/feature-gated-rotated-secret-26.3.5-isolated.json', import.meta.url)));
  assert.equal(rotated.rows[0].rotatedReadback, true);
  assert.equal(rotated.rows[0].absentReadback, true);
  const impersonation = JSON.parse(readFileSync(new URL('../validation/isolated-impersonation-26.3.5.json', import.meta.url)));
  assert.equal(impersonation.rows[0].workflowStatus, 'COMPLETED');
});

test('final default-feature reports count consent and moves but reject ineffective credential disable', () => {
  const names = [
    ['isolated-credential-actions-26.3.5.json', '43748f943f35b2d9415779a6a414370ecfdcd15d3fc1281acba939386b81b5e7'],
    ['isolated-consent-revocation-26.3.5.json', 'ed83b0f943462d8eb69ba23e7f40381ca1be4f8bdb8f803f01f9769250f78650'],
  ];
  const rows = [];
  for (const [file, digest] of names) {
    const bytes = readFileSync(new URL(`../validation/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    const report = JSON.parse(bytes);
    assert.equal(report.catalogVersion, '26.3.5');
    assert.equal(report.catalogSha256, 'c13a159f13ddaf20f11d4c7f93511589461f4779893941e8446809253e2300d5');
    assert.equal(report.fixtureRemoved ?? report.fixturesRemoved, true);
    rows.push(...report.rows);
  }
  assert.equal(rows.length, 4);
  assert.equal(rows.filter(row => row.readback === true).length, 3);
  const ineffective = rows.find(row => row.operation.endsWith('/disable-credential-types'));
  assert.equal(ineffective.status, 204);
  assert.equal(ineffective.readback, false);
  assert.equal(ineffective.remainingCredentials, 2);
});

test('storage-backed fixture closes the deployed action-route denominator', () => {
  const file = 'isolated-storage-credential-disable-26.3.5.json';
  const bytes = readFileSync(new URL(`../validation/${file}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '8a86609a60e7d483c6a91b863c2ec181ea4ab5dae6c0c51f8f593910174466dd');
  const storage = JSON.parse(bytes);
  assert.equal(storage.catalogVersion, '26.3.5');
  assert.equal(storage.catalogSha256,
    'c13a159f13ddaf20f11d4c7f93511589461f4779893941e8446809253e2300d5');
  assert.equal(storage.fixtureRemoved, true);
  assert.equal(storage.productionDiscoveryAfterCleanup, 200);
  assert.deepEqual(storage.rows.map(row => [row.operation, row.status, row.readback]), [[
    'PUT /admin/realms/{realm}/users/{user-id}/disable-credential-types', 204, true,
  ]]);
  assert.equal(storage.rows[0].storageBackedUser, true);
  assert.equal(storage.rows[0].backingStoreDisabledAfter, true);

  const read = name => JSON.parse(readFileSync(new URL(`../validation/${name}`, import.meta.url)));
  const base = read('mutation-valid-coverage-26.3.5-isolated.json');
  assert.equal(base.totalActionRoutes, 185);
  const completed = base.rows.filter(row => row.validFixtureState === 'HTTP_2XX_WITH_SUITE_ASSERTIONS')
    .map(row => row.operation);
  assert.equal(completed.length, 171);
  for (const [name] of reports) completed.push(...read(name).rows.map(row => row.operation));
  for (const name of ['isolated-impersonation-26.3.5.json',
    'feature-gated-rotated-secret-26.3.5-isolated.json']) {
    completed.push(...read(name).rows.map(row => row.operation));
  }
  for (const name of ['isolated-consent-revocation-26.3.5.json',
    'isolated-credential-actions-26.3.5.json']) {
    completed.push(...read(name).rows.filter(row => row.readback === true).map(row => row.operation));
  }
  completed.push(storage.rows[0].operation);
  assert.equal(completed.length, 185);
  assert.equal(new Set(completed).size, 185);
  assert.deepEqual(completed.sort(), base.rows.map(row => row.operation).sort());
});
