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

// `completed` holds { step, compensate, status } for each step that succeeded, compensate resolved.
export function completedReceipt(completed) {
  return completed.map(item => ({ operation: item.step.operation, path: receiptPath(item.step.args),
    status: item.status, compensation: item.compensate?.operation ?? null, compensationPath: receiptPath(item.compensate?.args) }));
}

// A private receipt file per run, replaced atomically on every write so a crash leaves the last state.
export function openJournal(config, plan) {
  const directory = config.journalDir || join(homedir(), '.local', 'state', 'keycloak-mcp');
  ensurePrivateDirectory(directory, 'journal directory');
  const id = randomUUID();
  const file = join(directory, `${id}.json`);
  const planReceipt = () => plan.map(step => ({ operation: step.operation, path: receiptPath(step.args),
    compensation: step.compensate?.operation ?? null, compensationPath: receiptPath(step.compensate?.args) }));
  return {
    id,
    write(record) {
      const temporary = `${file}.tmp`;
      const fd = openSync(temporary, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ runId: id, at: new Date().toISOString(), realm: config.realm, plan: planReceipt(), ...record }, null, 2) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, file);
    },
  };
}
