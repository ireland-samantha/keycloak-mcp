// Runs `node --check` on every module under src/ and openclaw/ and every script, so a new file
// cannot be skipped by a hand-maintained list.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = [['src', '.js'], ['openclaw', '.js'], ['scripts', '.mjs']];
const files = sources.flatMap(([directory, extension]) => readdirSync(join(root, directory), { recursive: true })
  .filter(name => name.endsWith(extension)).map(name => join(directory, name))).sort();
const failed = files.filter(file => spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' }).status !== 0);
console.log(`node --check: ${files.length - failed.length} of ${files.length} files passed`);
if (failed.length) process.exitCode = 1;
