import { readFileSync } from 'node:fs';

const files = {
  latest: { catalog: 'operations.json', openapi: 'openapi.json' },
  '26.3.5': { catalog: 'operations-26.3.5.json', openapi: 'openapi-26.3.5.json' },
};
const loaded = new Map();

const readData = name => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));

// Each version's operation list and OpenAPI definition are parsed on first use, then shared.
export function loadBundled(version) {
  if (!Object.hasOwn(files, version)) throw new Error('unsupported KEYCLOAK_MCP_CATALOG_VERSION');
  if (!loaded.has(version)) loaded.set(version, { catalog: readData(files[version].catalog), openapi: readData(files[version].openapi) });
  return loaded.get(version);
}
