import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { spawnStdioServer } from '../support/mcp-stdio.js';
import { startScenario, WRITER } from '../support/scenario.js';
import { createStep, missingUser } from '../support/steps.js';
import { privateTempDir } from '../support/temp.js';

const groupCreate = createStep('groups', 'group-id', { name: 'locked' });
const databaseUrl = process.env.KEYCLOAK_MCP_TEST_DATABASE_URL;
const withPostgres = databaseUrl ? {} : { skip: 'set KEYCLOAK_MCP_TEST_DATABASE_URL to a disposable PostgreSQL database' };

// Holds the group create at the mock until release() is called; `arrived` settles when it is held.
function holdGroupCreate(mock) {
  let release;
  let arrived;
  const released = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { arrived = resolve; });
  mock.on('POST /admin/realms/{realm}/groups', async (request, keycloak) => {
    arrived();
    await released;
    return keycloak.created(`${keycloak.realmPath}/groups/held`);
  }, (request, keycloak) => keycloak.created(`${keycloak.realmPath}/groups/next`));
  return { held, release };
}

const run = (mcp, steps = [groupCreate]) => mcp.call('keycloak_workflow', { execute: true, steps });

test('M1 a second workflow in the same process is refused while the first holds the realm', async t => {
  const { mock, mcp } = await startScenario(t, { settings: WRITER });
  const { held, release } = holdGroupCreate(mock);
  const first = run(mcp);
  await held;
  assert.equal((await run(mcp)).text, 'a workflow already holds this realm in this process');
  release();
  assert.equal((await first).value.status, 'COMPLETED');
  assert.equal((await run(mcp)).value.status, 'COMPLETED');
});

async function twoLockedServers(t) {
  const settings = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_LOCK_DATABASE_URL: databaseUrl };
  const scenario = await startScenario(t, { transport: 'stdio', settings });
  const other = spawnStdioServer({ settings: { ...scenario.settings, KEYCLOAK_MCP_JOURNAL_DIR: join(privateTempDir('keycloak-mcp-journal-'), 'journal') } });
  t.after(() => other.close());
  await other.session.initialize();
  return { ...scenario, other: other.session, otherServer: other };
}

test('M2 a PostgreSQL advisory lock serializes workflows across processes and is released afterwards', withPostgres, async t => {
  const { mock, mcp, other } = await twoLockedServers(t);
  const { held, release } = holdGroupCreate(mock);
  const first = run(mcp);
  await held;
  assert.equal((await run(other)).text, 'another workflow holds this realm');
  release();
  assert.equal((await first).value.status, 'COMPLETED');
  assert.equal((await run(other)).value.status, 'COMPLETED');
  assert.equal((await run(mcp, [groupCreate, missingUser])).value.status, 'IN_DOUBT');
  assert.equal((await run(other)).value.status, 'COMPLETED');
});

test('M3 losing the lock connection mid-run is reported instead of crashing the server', withPostgres, async t => {
  const { mock, mcp, server } = await twoLockedServers(t);
  const { held, release } = holdGroupCreate(mock);
  const first = run(mcp, [groupCreate, missingUser]);
  await held;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted");
  } finally { await admin.end(); }
  release();
  const result = await first;
  assert.equal(result.value.status, 'IN_DOUBT');
  assert.equal(server.child.exitCode, null, 'server exited');
});
