import { pathParameterNames } from '../internal/path-template.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function isRealmPinnedPath(path) {
  return typeof path === 'string' && /^\/(?:admin\/)?realms\/\{realm\}(?:\/|$)/.test(path) &&
    !/[?#\\%:]/.test(path) && !/\/\.{1,2}(?:\/|$)/.test(path) && !path.includes('//');
}

const isListOf = (value, valid) => Array.isArray(value ?? []) && (value ?? []).every(valid);

function parseOperation(item) {
  if (!item || !METHODS.includes(item.method) || !isRealmPinnedPath(item.path)) throw new Error('invalid extension operation');
  const names = pathParameterNames(item.path);
  if (names.some(name => !NAME.test(name))) throw new Error('invalid extension path parameter');
  if (item.method === 'GET' && item.readOnly !== true && item.readOnly !== false) throw new Error('extension GET must declare readOnly');
  if (typeof item.serviceAccountSupported !== 'boolean') throw new Error('extension operation must declare serviceAccountSupported');
  if (!isListOf(item.query, name => typeof name === 'string' && NAME.test(name))) throw new Error('invalid extension query');
  if (!isListOf(item.tags, value => typeof value === 'string')) throw new Error('invalid extension tags');
  for (const field of ['requestTypes', 'responseTypes'])
    if (!isListOf(item[field], value => typeof value === 'string' && MEDIA_TYPE.test(value))) throw new Error(`invalid extension ${field}`);
  const parameters = [
    ...names.map(name => ({ name, in: 'path', required: true, type: 'string' })),
    ...(item.query ?? []).map(name => ({ name, in: 'query', required: false, type: 'string' })),
  ];
  return { key: `${item.method} ${item.path}`, method: item.method, path: item.path,
    summary: item.summary ?? '', description: item.description ?? '', tags: item.tags ?? ['Extension'],
    parameters, requestTypes: item.requestTypes ?? [], responseTypes: item.responseTypes ?? [],
    requestBody: null, responses: {}, extension: true, readOnly: item.readOnly === true,
    irreversible: item.irreversible !== false, serviceAccountSupported: item.serviceAccountSupported };
}

// Validates a deployment's private SPI route list and returns its operations in file order.
export function parseExtensionCatalog(extension) {
  if (!extension || !Array.isArray(extension.operations) || typeof extension.source !== 'string') throw new Error('invalid extension catalog');
  return extension.operations.map(item => parseOperation(item));
}
