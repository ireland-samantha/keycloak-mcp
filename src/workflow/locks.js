import { createHash } from 'node:crypto';

const heldInProcess = new Set();

async function acquireLocal(key) {
  if (heldInProcess.has(key)) throw new Error('a workflow already holds this realm in this process');
  heldInProcess.add(key);
  return { assertHeld: async () => {}, release: async () => { heldInProcess.delete(key); } };
}

async function acquirePostgres(connectionString, key) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  const signedKey = createHash('sha256').update(key).digest().readBigInt64BE().toString();
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [signedKey]);
    if (!result.rows[0].acquired) throw new Error('another workflow holds this realm');
    return {
      assertHeld: async () => { await client.query('SELECT 1'); },
      release: async () => {
        try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [signedKey]); }
        finally { await client.end(); }
      },
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}

// One workflow at a time per Keycloak base URL and realm: across processes through a PostgreSQL
// advisory lock when one is configured, otherwise within this process.
export function acquireRealmLock(config) {
  const key = `${config.baseUrl}|${config.realm}`;
  return config.lockDatabaseUrl ? acquirePostgres(config.lockDatabaseUrl, key) : acquireLocal(key);
}
