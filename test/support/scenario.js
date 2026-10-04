import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectInProcess } from './mcp-client.js';
import { spawnStdioServer } from './mcp-stdio.js';
import { startMockKeycloak } from './mock-keycloak.js';
import { privateTempDir } from './temp.js';

export const WRITER = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };

// One mock Keycloak plus one MCP server configured against it, torn down after the test.
// transport 'stdio' spawns src/index.js; 'inprocess' connects createServer() in memory.
export async function startScenario(t, { transport = 'inprocess', settings = {}, mock: mockOptions } = {}) {
  const cleanup = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); });
  const mock = await startMockKeycloak(mockOptions);
  cleanup.push(() => mock.close());
  const home = privateTempDir('keycloak-mcp-home-');
  const journalDir = join(home, 'journal');
  const allSettings = {
    KEYCLOAK_BASE_URL: mock.origin, KEYCLOAK_REALM: mock.realm, KEYCLOAK_AUTH_REALM: mock.authRealm,
    KEYCLOAK_CLIENT_ID: mock.clientId, KEYCLOAK_CLIENT_SECRET: mock.clientSecret, KEYCLOAK_MCP_JOURNAL_DIR: journalDir,
    ...settings,
  };
  let server;
  let mcp;
  if (transport === 'stdio') {
    server = spawnStdioServer({ settings: allSettings, home });
    cleanup.push(() => server.close());
    mcp = server.session;
    await mcp.initialize();
  } else {
    mcp = await connectInProcess(allSettings);
    cleanup.push(() => mcp.close());
  }
  return { mock, mcp, server, home, journalDir, settings: allSettings };
}

// Starts a scenario, lets `program` set up the mock, and executes `steps` as one workflow.
export async function executeWorkflow(t, steps, { settings = WRITER, transport, program = () => {} } = {}) {
  const scenario = await startScenario(t, { settings, transport });
  program(scenario.mock, scenario);
  const { value, text, isError } = await scenario.mcp.call('keycloak_workflow', { execute: true, steps });
  return { ...scenario, result: value, text, isError };
}

// A refusal must come before any request reaches Keycloak, the token endpoint included.
export function assertRefusedOffline(mock, result, message) {
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, message);
  assert.deepEqual(mock.requests.map(request => request.key), []);
}

export function receipts(journalDir) {
  let files;
  try { files = readdirSync(journalDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(file => file.endsWith('.json')).map(file => ({ file, ...JSON.parse(readFileSync(join(journalDir, file), 'utf8')) }));
}

