import { createCatalog } from '../../src/api.js';

export const catalogVersions = ['latest', '26.3.5'];

const catalogs = new Map();

export function bundledCatalog(version = 'latest') {
  if (!catalogs.has(version)) catalogs.set(version, createCatalog('', version));
  return catalogs.get(version);
}

export function samplePathArgs(operation, value = 'safe-value') {
  return Object.fromEntries(operation.parameters.filter(parameter => parameter.in === 'path' && parameter.name !== 'realm')
    .map(parameter => [parameter.name, value]));
}
