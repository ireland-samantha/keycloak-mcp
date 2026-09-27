import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bytes = path => readFileSync(new URL(`../${path}`, import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const tools = ['keycloak_search_operations', 'keycloak_describe_operation', 'keycloak_describe_schema', 'keycloak_read', 'keycloak_workflow'];
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
  assert.deepEqual(value.cleanup, { gatewaysStopped: true, realmDelete: 204, realmAbsentRead: 404, workDirRemoved: true });
  const ids = new Set(value.evidence.map(item => item.id));
  for (const item of value.requirements) assert.ok(item.evidence.every(id => id === 'cleanup' || ids.has(id)), item.id);
  return { value, step: Object.fromEntries(value.evidence.map(item => [item.step, item])),
    status: Object.fromEntries(value.requirements.map(item => [item.id, item.status])) };
}

const after = receipt('openclaw-2026.9.6-integration.json', '7cbb667e35cf77c639db112efa122be1f58a504ed69b11e5bddb5c196edc3af4');

test('OpenClaw 2026.9.6 installs the packed extension and serves its tools through the Gateway', () => {
  const { value, step, status } = after;
  for (const [path, digest] of Object.entries(value.sourceSha256)) assert.equal(sha256(bytes(path)), digest, path);
  assert.equal(sha256(bytes(value.harness.script)), value.harness.sha256);
  assert.equal(JSON.parse(bytes('data/operations.json')).sourceSha256, value.catalog.sourceSha256);
  assert.deepEqual(JSON.parse(bytes('openclaw.plugin.json')).contracts.tools, tools);
  // Re-derive each requirement from the recorded observations rather than trusting its status.
  assert.deepEqual([step.install.exitCode, step.install.installed], [0, true]);
  assert.equal(step.metadata.imported, false);
  assert.deepEqual(step.metadata.contractTools, tools);
  assert.deepEqual([...step.metadata.consentedTools].sort(), [...tools].sort());
  assert.deepEqual([step.unconfigured.status, step.unconfigured.tools], ['error', []]);
  assert.match(step.unconfigured.diagnostics[0], /KEYCLOAK_BASE_URL is required/);
  assert.deepEqual([step.runtime.status, step.runtime.imported, step.runtime.tools, step.runtime.diagnostics], ['loaded', true, tools, 0]);
  assert.deepEqual([step.runtime.configMode, step.runtime.keycloakVariablesPassed], ['0600', 0]);
  assert.deepEqual([step.doctor.ok, step.doctor.pluginErrors, step.doctor.diagnostics], [true, 0, 0]);
  for (const key of ['gateway-search', 'gateway-describe', 'gateway-schema', 'gateway-read', 'gateway-preflight-write'])
    assert.deepEqual([step[key].httpStatus, step[key].ok, step[key].gradedError], [200, true, false], key);
  assert.deepEqual([step['gateway-read'].detailsStatus, step['gateway-read'].realmMatches], [200, true]);
  for (const key of refusals) assert.deepEqual([step[key].httpStatus, step[key].gradedError], [200, true], key);
  assert.match(step['gateway-read-refuses-mutation'].text, /compensating workflow/);
  assert.match(step['gateway-execute-read-only'].text, /writes are disabled/);
  assert.deepEqual([step['gateway-read-only-count'].exactNameCountBefore, step['gateway-read-only-count'].exactNameCountAfter], [0, 0]);
  assert.equal(step['gateway-preflight-write'].detailsStatus, 'PREFLIGHT_OK');
  const cycle = step['gateway-compensated-write'];
  assert.deepEqual([cycle.detailsStatus, cycle.gradedError], ['IN_DOUBT', true]);
  assert.deepEqual([cycle.createStatus, cycle.forcedReadFailure, cycle.rollbackStatus], [201, 404, 204]);
  assert.deepEqual([cycle.failedStepMayHaveCommitted, cycle.priorStepsCompensated], [false, true]);
  assert.deepEqual([cycle.exactNameCountBefore, cycle.exactNameCountAfter, cycle.groupCountBefore, cycle.groupCountAfter], [0, 0, 0, 0]);
  assert.deepEqual([cycle.journalDirMode, cycle.receiptModes], ['0700', ['0600']]);
  assert.deepEqual(Object.keys(status), ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5', 'REQ-6', 'REQ-7', 'REQ-8']);
  assert.ok(Object.values(status).every(item => item === 'PROVEN'));
});

test('with the shipped manifest, OpenClaw 2026.9.6 rejected every tool', () => {
  const { value, step, status } = receipt('openclaw-2026.9.6-before-manifest-fix.json',
    'c4c2d3452a01abf8af91e93f57b5ac951c59e09a54002c90eec0e152c24089a6');
  assert.equal(value.harness.sha256, after.value.harness.sha256);
  assert.deepEqual(value.sourceSha256, { ...after.value.sourceSha256,
    'openclaw/index.js': ungradedExtensionSha256, 'openclaw.plugin.json': shippedManifestSha256 });
  assert.deepEqual([step.metadata.contractTools, step.metadata.consentedTools], [[], []]);
  assert.deepEqual([step.runtime.status, step.runtime.tools], ['loaded', []]);
  assert.deepEqual(step.runtime.diagnosticMessages, ['plugin must declare contracts.tools before registering agent tools']);
  assert.equal(step.doctor.ok, false);
  const gateway = value.evidence.filter(item => item.step.startsWith('gateway-'));
  assert.equal(gateway.length, 10);
  assert.ok(gateway.every(item => item.httpStatus === 404), 'every Gateway call returned 404');
  assert.deepEqual(Object.entries(status).filter(([, item]) => item === 'PROVEN').map(([id]) => id), ['REQ-1', 'REQ-3', 'REQ-8']);
});

test('before failed results carried details, OpenClaw graded refusals as successful', () => {
  const { value, step, status } = receipt('openclaw-2026.9.6-before-grading-fix.json',
    '474bcb4335edb0ea43591524c0edb120c7ce4a7bd593275d64e1dfcfa33459dc');
  assert.equal(value.harness.sha256, after.value.harness.sha256);
  assert.deepEqual(value.sourceSha256, { ...after.value.sourceSha256, 'openclaw/index.js': ungradedExtensionSha256 });
  for (const key of refusals) assert.deepEqual([step[key].httpStatus, step[key].ok, step[key].gradedError], [200, true, false], key);
  assert.equal(step['gateway-compensated-write'].gradedError, true);
  assert.deepEqual(Object.entries(status).filter(([, item]) => item !== 'PROVEN'), [['REQ-6', 'CONTRADICTED']]);
});
