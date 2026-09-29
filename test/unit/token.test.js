import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceAccountToken } from '../../src/http/token.js';
import { testConfig } from '../support/config.js';
import { tokenResponse } from '../support/fetch.js';

// A token endpoint that counts grants, answers once `release()` is called, and issues token-1, token-2, ...
function tokenEndpoint(expiresIn) {
  const endpoint = { grants: 0, waiting: [] };
  endpoint.fetch = () => new Promise(resolve => {
    const name = `token-${++endpoint.grants}`;
    endpoint.waiting.push(() => resolve(tokenResponse(name, expiresIn)));
  });
  endpoint.release = () => { for (const answer of endpoint.waiting.splice(0)) answer(); };
  return endpoint;
}

function clock(start = 1_000_000) {
  const time = { now: start };
  return { now: () => time.now, advance: ms => { time.now += ms; } };
}

async function granted(token, endpoint) {
  const pending = token.get();
  endpoint.release();
  return pending;
}

test('concurrent callers share one grant', async () => {
  const endpoint = tokenEndpoint(300);
  const token = new ServiceAccountToken(testConfig(), endpoint.fetch);
  const pending = [token.get(), token.get(), token.get()];
  endpoint.release();
  assert.deepEqual(await Promise.all(pending), ['token-1', 'token-1', 'token-1']);
  assert.equal(endpoint.grants, 1);
});

test('a token is refreshed 30 s before it expires, or halfway through a lifetime shorter than 60 s', async () => {
  for (const [expiresIn, reuseUntilMs] of [[300, 270_000], [20, 10_000]]) {
    const endpoint = tokenEndpoint(expiresIn);
    const time = clock();
    const token = new ServiceAccountToken(testConfig(), endpoint.fetch, { now: time.now });
    assert.equal(await granted(token, endpoint), 'token-1');
    time.advance(reuseUntilMs - 1);
    assert.equal(await granted(token, endpoint), 'token-1', `expires_in ${expiresIn}: still reused`);
    time.advance(1);
    assert.equal(await granted(token, endpoint), 'token-2', `expires_in ${expiresIn}: refreshed`);
  }
});

test('a grant requested before invalidate() is not cached after it', async () => {
  const endpoint = tokenEndpoint(300);
  const token = new ServiceAccountToken(testConfig(), endpoint.fetch);
  const beforeInvalidation = token.get();
  token.invalidate();
  const afterInvalidation = token.get();
  endpoint.release();
  assert.deepEqual([await beforeInvalidation, await afterInvalidation], ['token-1', 'token-2']);
  assert.equal(await granted(token, endpoint), 'token-2');
  assert.equal(endpoint.grants, 2);
});
