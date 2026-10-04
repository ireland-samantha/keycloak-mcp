import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Read from package.json so a release cannot advertise a stale name or version.
export const packageInfo = Object.freeze({ name: pkg.name, version: pkg.version });
