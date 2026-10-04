import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';

const groupOrOtherAccess = 0o077;

export function readPrivateJson(path, label) {
  const invalidFile = () => new Error(`${label} must be a private file (mode 0600, no symlinks)`);
  const before = lstatSync(path);
  if (!before.isFile()) throw invalidFile();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw invalidFile();
    throw error;
  }
  try {
    const info = fstatSync(fd);
    // Comparing the opened file with lstat also detects swaps where O_NOFOLLOW is unavailable.
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw invalidFile();
    if ((info.mode & groupOrOtherAccess) !== 0) throw new Error(`${label} must be a private file (mode 0600)`);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export function ensurePrivateDirectory(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & groupOrOtherAccess) !== 0) throw new Error(`${label} must be private (mode 0700)`);
}
