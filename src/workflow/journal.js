import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '../internal/private-file.js';
import { REDACTED } from '../internal/redaction.js';
import { isSensitiveReceiptParameter } from '../policy/classify.js';

// Receipts record path parameters only, never bodies or query values.
export function receiptPath(args = {}) {
  return Object.fromEntries(Object.entries(args.path ?? {}).map(([name, value]) => [name, isSensitiveReceiptParameter(name) ? REDACTED : String(value)]));
}

// A step's Location and created ID as the receipt keeps them. The Location repeats the step's path,
// so it is withheld whenever one of the step's path parameters is, and the ID whenever the parameter
// it fills is.
export function createdReceipt({ step, location, created = null }) {
  const hidesId = Boolean(created) && isSensitiveReceiptParameter(created.parameter);
  const hidesPath = hidesId || Object.keys(step.args.path ?? {}).some(isSensitiveReceiptParameter);
  return { ...(location ? { location: hidesPath ? REDACTED : location } : {}), ...(created ? { id: hidesId ? REDACTED : created.id } : {}) };
}

// `completed` holds { step, status, location, created, compensate } for each step that succeeded,
// compensate resolved.
export function completedReceipt(completed) {
  return completed.map(item => ({ operation: item.step.operation, path: receiptPath(item.step.args), status: item.status,
    ...createdReceipt(item), compensation: item.compensate?.operation ?? null, compensationPath: receiptPath(item.compensate?.args) }));
}

// A rename is durable only once the directory holding it is: without this, a power loss can leave the
// previous receipt, or none, in place of the one just written.
function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// A private receipt file per run, replaced atomically on every write so a crash leaves the last state.
// write() throws, for the receipt a step needs before its request is sent; record() is for receipts
// written after Keycloak has changed, which must never stop the compensation that follows, and keeps
// its failures in `failures` for the result instead.
export function openJournal(config, plan) {
  const directory = config.journalDir || join(homedir(), '.local', 'state', 'keycloak-mcp');
  ensurePrivateDirectory(directory, 'journal directory');
  const id = randomUUID();
  const file = join(directory, `${id}.json`);
  const planReceipt = () => plan.map(step => ({ operation: step.operation, path: receiptPath(step.args),
    compensation: step.compensate?.operation ?? null, compensationPath: receiptPath(step.compensate?.args) }));
  const failures = [];
  const write = record => {
    const temporary = `${file}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ runId: id, at: new Date().toISOString(), realm: config.realm, plan: planReceipt(), ...record }, null, 2) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(directory);
  };
  return {
    id,
    failures,
    write,
    record(record) {
      try { write(record); } catch (error) { failures.push(`${record.status}: ${error.message}`); }
    },
  };
}
