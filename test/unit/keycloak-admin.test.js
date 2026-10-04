import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeycloakAdmin } from '../../src/keycloak-admin.js';
import { testConfig } from '../support/config.js';
import { fakeKeycloak, jsonResponse } from '../support/fetch.js';

const readRealm = 'GET /admin/realms/{realm}';

// Never answers; rejects with the abort reason once the request's timeout signal fires. The interval
// stands in for a real socket: AbortSignal.timeout alone does not keep the event loop running.
const hang = (_url, options) => new Promise((_resolve, reject) => {
  const pending = setInterval(() => {}, 1000);
  options.signal.addEventListener('abort', () => { clearInterval(pending); reject(options.signal.reason); });
});

test('a safe read waits between transient retries through the injected sleep, 150 ms then 400 ms', async () => {
  const slept = [];
  let reads = 0;
  const admin = new KeycloakAdmin(testConfig(), fakeKeycloak(() => (++reads < 3 ? jsonResponse(503, {}) : jsonResponse(200, {}))),
    { sleep: async ms => { slept.push(ms); } });
  assert.equal((await admin.invoke(readRealm)).attempts, 3);
  assert.deepEqual(slept, [150, 400]);
});

test('retryDelaysMs bounds how often a transient failure is retried', async () => {
  const admin = new KeycloakAdmin(testConfig(), fakeKeycloak(() => jsonResponse(503, {})), { sleep: async () => {}, retryDelaysMs: [1] });
  await assert.rejects(admin.invoke(readRealm), /HTTP 503; attempts 2/);
});

// Far below the 15 s token and 30 s request defaults, so a test fails if its injected timeout is ignored.
const injectedTimeoutBound = { timeout: 2_000 };

test('an injected tokenTimeoutMs aborts a token request that never answers', injectedTimeoutBound, async () => {
  const tokenHangs = new KeycloakAdmin(testConfig(), fakeKeycloak(() => jsonResponse(200, {}), { token: hang }), { tokenTimeoutMs: 20 });
  await assert.rejects(tokenHangs.invoke(readRealm), { name: 'TimeoutError' });
});

test('an injected requestTimeoutMs aborts a Keycloak call that never answers', injectedTimeoutBound, async () => {
  const readHangs = new KeycloakAdmin(testConfig(), fakeKeycloak(hang), { requestTimeoutMs: 20 });
  await assert.rejects(readHangs.invoke(readRealm), { name: 'TimeoutError' });
});
