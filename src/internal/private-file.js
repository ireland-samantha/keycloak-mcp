import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';

const groupOrOtherAccess = 0o077;

export function readPrivateJson(path, label) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`${label} must be a private file (mode 0600, no symlinks)`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & groupOrOtherAccess) !== 0) throw new Error(`${label} must be a private file (mode 0600)`);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export function ensurePrivateDirectory(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & groupOrOtherAccess) !== 0) throw new Error(`${label} must be private (mode 0700)`);
}
