import { mkdirSync, readFileSync, statSync } from 'node:fs';

const groupOrOtherAccess = 0o077;

export function readPrivateJson(path, label) {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & groupOrOtherAccess) !== 0) throw new Error(`${label} must be a private file (mode 0600)`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function ensurePrivateDirectory(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & groupOrOtherAccess) !== 0) throw new Error(`${label} must be private (mode 0700)`);
}
