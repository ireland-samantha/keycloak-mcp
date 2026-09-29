import assert from 'node:assert/strict';
import fs, { renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { KeycloakAdmin, runWorkflow } from '../../src/api.js';
import { openJournal } from '../../src/workflow/journal.js';
import { testConfig } from '../support/config.js';
import { fakeKeycloak, jsonResponse } from '../support/fetch.js';
import { privateTempDir } from '../support/temp.js';

const writer = { KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true' };
const realmUpdate = { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'changed' } },
  compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'original' } } } };

// Records the file-system calls a receipt write makes, in order, through the builtin module that
// journal.js imports its functions from.
function recordFileSystem(t) {
  const calls = [];
  const spy = (name, describe) => {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      const result = original(...args);
      calls.push(describe(args, result));
      return result;
    });
  };
  spy('openSync', ([path], fd) => ['open', path, fd]);
  spy('fsyncSync', ([fd]) => ['fsync', fd]);
  spy('renameSync', ([, to]) => ['rename', to]);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('every receipt write syncs the journal directory after the rename that publishes it', t => {
  const directory = join(privateTempDir('keycloak-mcp-journal-sync-'), 'journal');
  const journal = openJournal(testConfig({ KEYCLOAK_MCP_JOURNAL_DIR: directory }), []);
  const calls = recordFileSystem(t);
  journal.write({ status: 'RUNNING' });
  journal.write({ status: 'COMPLETED' });
  // Descriptors are reused once closed, so each fsync is matched with the latest open of its descriptor.
  const openedAs = new Map();
  const steps = calls.map(([call, target, fd]) => {
    if (call === 'open') openedAs.set(fd, target);
    return call === 'fsync' && openedAs.get(target) === directory ? 'sync directory' : call;
  });
  assert.deepEqual(steps, ['open', 'fsync', 'rename', 'open', 'sync directory', 'open', 'fsync', 'rename', 'open', 'sync directory']);
});

// Moves the journal directory away and leaves a file in its place, so every later receipt write fails.
function breakJournal(directory) {
  renameSync(directory, `${directory}.moved`);
  writeFileSync(directory, 'not a directory');
}

test('a receipt that cannot be written after the last step commits leaves the run COMPLETED and says so', async () => {
  const directory = join(privateTempDir('keycloak-mcp-journal-break-'), 'journal');
  const admin = new KeycloakAdmin(testConfig({ ...writer, KEYCLOAK_MCP_JOURNAL_DIR: directory }), fakeKeycloak(() => {
    breakJournal(directory);
    return jsonResponse(204, null);
  }));
  const result = await runWorkflow(admin, [realmUpdate], { dryRun: false });
  assert.equal(result.status, 'COMPLETED');
  assert.match(result.runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.completed, [{ operation: realmUpdate.operation, status: 204 }]);
  assert.match(result.journalErrors.join('\n'), /^RUNNING: .*\nCOMPLETED: /);
});

test('a receipt that cannot be written before a step stops the run before that step is sent', async () => {
  const directory = join(privateTempDir('keycloak-mcp-journal-break-'), 'journal');
  const sent = [];
  const admin = new KeycloakAdmin(testConfig({ ...writer, KEYCLOAK_MCP_JOURNAL_DIR: directory }), fakeKeycloak((url, options) => {
    sent.push(options.method);
    if (sent.length === 1) breakJournal(directory);
    return jsonResponse(204, null);
  }));
  const result = await runWorkflow(admin, [realmUpdate, realmUpdate], { dryRun: false });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, false);
  assert.deepEqual(sent, ['PUT', 'PUT'], 'the second step is never sent; only the first step\'s compensation follows');
  assert.deepEqual(result.rollback.map(item => item.outcome), ['COMPENSATED']);
});
