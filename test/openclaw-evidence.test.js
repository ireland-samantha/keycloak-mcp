import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluate, tools } from '../scripts/openclaw-requirements.mjs';

const bytes = path => readFileSync(new URL(`../${path}`, import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const refusals = ['gateway-read-refuses-mutation', 'gateway-preflight-read-only', 'gateway-execute-read-only'];
// The manifest published at 0f16b7f and the extension before its failed results carried details.
const shippedManifestSha256 = '1f0ff55e377f63ff3484f0b16e081358d370628d2518f5539b528843df90edbc';
const ungradedExtensionSha256 = 'ab05cb905479f6c7905caeb76a49fb527f02af156d404c0e5f622b82d27b024b';

function receipt(name, digest) {
  const raw = bytes(`validation/${name}`);
  assert.equal(sha256(raw), digest);
  assert.doesNotMatch(raw.toString('utf8'), /\/(?:tmp|home|root|Users)\//);
  const value = JSON.parse(raw);
  assert.equal(value.openclaw.version, '2026.9.6');
  assert.equal(value.openclaw.integrity, 'sha512-Ie0kyQSCVfFqixsgVg39vevUDq01Ch5u3+7Yu5Y3qARczmdAe+lzp8bVnO9925rHiW/+CFp70zfORCyPmCH31g==');
  assert.equal(value.keycloakVersion, '26.7.4');
  assert.equal(value.admission, 'NOT_RUN');
  assert.equal(value.failure, undefined);
  assert.deepEqual(value.cleanup, { gatewaysExited: true, realmDelete: 204, realmAbsentRead: 404, workDirRemoved: true });
  // The shared predicates, applied to the recorded observations, must reproduce every recorded status.
  assert.deepEqual(value.requirements, evaluate(value.evidence, value.cleanup));
  return { value, step: Object.fromEntries(value.evidence.map(item => [item.step, item])),
    status: Object.fromEntries(value.requirements.map(item => [item.id, item.status])) };
}

const after = receipt('openclaw-2026.9.6-integration.json', '9720d42de7bf3900542f9604ea16e89b0c383f8f2d21cea83ed45919897a7eff');

test('OpenClaw 2026.9.6 installs the packed extension and serves its tools through the Gateway', () => {
  const { value, step, status } = after;
  for (const [path, digest] of Object.entries(value.sourceSha256)) assert.equal(sha256(bytes(path)), digest, path);
  for (const [path, digest] of Object.entries(value.harness)) assert.equal(sha256(bytes(path)), digest, path);
  assert.equal(JSON.parse(bytes('data/operations.json')).sourceSha256, value.catalog.sourceSha256);
  assert.deepEqual(JSON.parse(bytes('openclaw.plugin.json')).contracts.tools, tools);
  assert.deepEqual(Object.values(status), Array(8).fill('PROVEN'));
  // Spot values, stated independently of the shared predicates.
  assert.equal(step.metadata.installedUnderThrowawayHome, true);
  assert.deepEqual([...step.metadata.consentedTools].sort(), [...tools].sort());
  assert.match(step.unconfigured.diagnostics[0], /KEYCLOAK_BASE_URL is required/);
  assert.deepEqual([step.runtime.status, step.runtime.tools, step.runtime.diagnostics], ['loaded', tools, 0]);
  assert.deepEqual([step['gateway-read'].detailsStatus, step['gateway-read'].realmMatches], [200, true]);
  for (const key of refusals) assert.deepEqual([step[key].httpStatus, step[key].gradedError], [200, true], key);
  assert.equal(step['gateway-read-only-count'].controlExactNameCount, 1);
  const cycle = step['gateway-compensated-write'];
  assert.deepEqual([cycle.createStatus, cycle.forcedReadFailure, cycle.rollbackStatus, cycle.detailsStatus], [201, 404, 204, 'IN_DOUBT']);
  assert.deepEqual([cycle.groupCountBefore, cycle.groupCountAfter, cycle.journalDirMode, cycle.receiptModes], [1, 1, '0700', ['0600']]);
});

test('with the shipped manifest, OpenClaw 2026.9.6 rejected every tool', () => {
  const { value, step, status } = receipt('openclaw-2026.9.6-before-manifest-fix.json',
    '247d4cc1ac32e0fd92f7c29a638360c1afe4a12d2adb335546b0777ceed582b0');
  assert.deepEqual(value.harness, after.value.harness);
  assert.deepEqual(value.sourceSha256, { ...after.value.sourceSha256,
    'openclaw/index.js': ungradedExtensionSha256, 'openclaw.plugin.json': shippedManifestSha256 });
  assert.deepEqual([step.metadata.contractTools, step.metadata.consentedTools, step.runtime.tools], [[], [], []]);
  assert.deepEqual(step.runtime.diagnosticMessages, ['plugin must declare contracts.tools before registering agent tools']);
  const gateway = value.evidence.filter(item => item.step.startsWith('gateway-'));
  assert.equal(gateway.length, 10);
  for (const item of gateway) {
    assert.equal(item.httpStatus, 404, item.step);
    assert.match(item.error, /^Tool not available: keycloak_/, item.step);
  }
  assert.deepEqual(status, { 'REQ-1': 'PROVEN', 'REQ-2': 'CONTRADICTED', 'REQ-3': 'PROVEN', 'REQ-4': 'CONTRADICTED',
    'REQ-5': 'CONTRADICTED', 'REQ-6': 'CONTRADICTED', 'REQ-7': 'CONTRADICTED', 'REQ-8': 'PROVEN' });
});

test('before failed results carried details, OpenClaw graded refusals as successful', () => {
  const { value, step, status } = receipt('openclaw-2026.9.6-before-grading-fix.json',
    '05ee25a54394b4765c5fdc4c52dcfa5e75488a7d48e9c80c92ed0aaba7fbb5c9');
  assert.deepEqual(value.harness, after.value.harness);
  assert.deepEqual(value.sourceSha256, { ...after.value.sourceSha256, 'openclaw/index.js': ungradedExtensionSha256 });
  for (const key of refusals) assert.deepEqual([step[key].httpStatus, step[key].ok, step[key].gradedError], [200, true, false], key);
  assert.equal(step['gateway-compensated-write'].gradedError, true);
  assert.deepEqual(Object.entries(status).filter(([, item]) => item !== 'PROVEN'), [['REQ-6', 'CONTRADICTED']]);
});
