import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { holdAdvisoryLock } from '../../src/workflow/locks.js';

// Behaves like a pg Client: after a connection error it emits 'error' and refuses queries.
class FakePgClient extends EventEmitter {
  queries = [];
  ended = false;
  broken = false;
  constructor({ lockFree = true } = {}) {
    super();
    this.lockFree = lockFree;
  }
  async connect() {}
  async query(text) {
    if (this.broken) throw new Error('Client has encountered a connection error and is not queryable');
    this.queries.push(text);
    return { rows: [{ acquired: this.lockFree }] };
  }
  async end() { this.ended = true; }
  // What pg does when the server closes an idle connection (idle_session_timeout, pg_terminate_backend).
  dropConnection() {
    this.broken = true;
    this.emit('error', new Error('terminating connection due to administrator command'));
  }
}

test('a dropped lock connection is reported by the next check instead of crashing the process', async () => {
  const client = new FakePgClient();
  const lock = await holdAdvisoryLock(client, 'https://id.example.com|realm');
  client.dropConnection();
  await assert.rejects(lock.assertHeld(), { message: 'lost the PostgreSQL lock connection: terminating connection due to administrator command' });
});

test('releasing a lock whose connection dropped closes the client without querying it', async () => {
  const client = new FakePgClient();
  const lock = await holdAdvisoryLock(client, 'https://id.example.com|realm');
  client.dropConnection();
  await lock.release();
  assert.equal(client.ended, true);
  assert.deepEqual(client.queries, ['SELECT pg_try_advisory_lock($1::bigint) AS acquired']);
});

test('a held lock is checked with a query and released with pg_advisory_unlock', async () => {
  const client = new FakePgClient();
  const lock = await holdAdvisoryLock(client, 'https://id.example.com|realm');
  await lock.assertHeld();
  await lock.release();
  assert.deepEqual(client.queries, ['SELECT pg_try_advisory_lock($1::bigint) AS acquired', 'SELECT 1', 'SELECT pg_advisory_unlock($1::bigint)']);
  assert.equal(client.ended, true);
});

test('a lock another workflow holds is refused and its client closed', async () => {
  const client = new FakePgClient({ lockFree: false });
  await assert.rejects(holdAdvisoryLock(client, 'https://id.example.com|realm'), { message: 'another workflow holds this realm' });
  assert.equal(client.ended, true);
});
