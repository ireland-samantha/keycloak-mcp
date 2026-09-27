import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function evidence(name, digest) {
  const bytes = readFileSync(new URL(`../validation/${name}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  return bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('isolated SMTP sink captured test mail and both organization invitations', () => {
  const rows = evidence('smtp-delivery-26.3.5-isolated.jsonl',
    '09c87c01b4ea08ecc3a15a63a2f7db59b9128cfdb8f946e5d70bcf1568f2b87e');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(row => row.subject), [
    'Verify email', 'Update Your Account', 'Update Your Account',
    '[KEYCLOAK] - SMTP test message',
    ...Array(2).fill('Invitation to join the mcp-invite-62781c1e organization'),
  ]);
  assert.ok(rows.every(row => row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.sha256) &&
    row.recipients.every(address => address.endsWith('example.invalid>'))));
  assert.notEqual(rows[4].recipients[0], rows[5].recipients[0]);
});

test('isolated HTTP sink captured revocation callbacks, metadata fetch, and JWKS reload', () => {
  const rows = evidence('http-callbacks-26.3.5-isolated.jsonl',
    '2ff71eecf917bb27cab09c6dd5841cffb47a01d41dd52ebb20414076793551a7');
  assert.equal(rows.length, 9);
  assert.equal(rows.filter(row => row.method === 'POST' && row.path === '/callback/k_push_not_before').length, 5);
  assert.equal(rows.filter(row => row.method === 'GET' && row.path === '/.well-known/openid-configuration').length, 3);
  assert.equal(rows.filter(row => row.method === 'GET' && row.path === '/jwks').length, 1);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
});
