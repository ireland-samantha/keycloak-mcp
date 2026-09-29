import { createHash } from 'node:crypto';

const heldInProcess = new Set();

async function acquireLocal(key) {
  if (heldInProcess.has(key)) throw new Error('a workflow already holds this realm in this process');
  heldInProcess.add(key);
  return { assertHeld: async () => {}, release: async () => { heldInProcess.delete(key); } };
}

// Takes the advisory lock for `key` on a new pg client and returns its handle. The lock lives as long
// as the client's session: when the server closes the connection (idle_session_timeout, a failover,
// pg_terminate_backend) the lock is gone and pg emits 'error' on the idle client, which would crash
// the process in the middle of a workflow if nothing listened.
export async function holdAdvisoryLock(client, key) {
  let lost = null;
  client.on('error', error => { lost = error; });
  const signedKey = createHash('sha256').update(key).digest().readBigInt64BE().toString();
  try {
    await client.connect();
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [signedKey]);
    if (!result.rows[0].acquired) throw new Error('another workflow holds this realm');
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    assertHeld: async () => {
      if (lost) throw new Error(`lost the PostgreSQL lock connection: ${lost.message}`);
      await client.query('SELECT 1');
    },
    // A lost session has already released its lock, and its client can only be closed.
    release: async () => {
      try { if (!lost) await client.query('SELECT pg_advisory_unlock($1::bigint)', [signedKey]); }
      finally { await client.end(); }
    },
  };
}

async function acquirePostgres(connectionString, key) {
  const { Client } = await import('pg');
  return holdAdvisoryLock(new Client({ connectionString, connectionTimeoutMillis: 5000 }), key);
}

// One workflow at a time per Keycloak base URL and realm: across processes through a PostgreSQL
// advisory lock when one is configured, otherwise within this process.
export function acquireRealmLock(config) {
  const key = `${config.baseUrl}|${config.realm}`;
  return config.lockDatabaseUrl ? acquirePostgres(config.lockDatabaseUrl, key) : acquireLocal(key);
}
