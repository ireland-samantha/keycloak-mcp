import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJournal } from '../../src/workflow/journal.js';
import { testConfig } from '../support/config.js';
import { privateTempDir } from '../support/temp.js';

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
