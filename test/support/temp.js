import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];
process.once('exit', () => { for (const dir of created) rmSync(dir, { recursive: true, force: true }); });

// mkdtemp creates the directory with mode 0700, which keycloak-mcp requires of its journal directory.
export function privateTempDir(prefix = 'keycloak-mcp-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function writePrivateJson(file, value) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}
