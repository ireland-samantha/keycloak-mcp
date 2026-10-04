import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureProvenance } from '../support/mock-keycloak.js';

test('recorded fixtures name the server they came from and carry no tokens', () => {
  assert.match(fixtureProvenance.imageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(fixtureProvenance.serverVersion, /\S/);
  assert.match(fixtureProvenance.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
  const text = readFileSync(new URL('fixtures/keycloak-head.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /eyJ[\w-]+\.[\w-]+\./);
});
