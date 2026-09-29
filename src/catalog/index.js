import { readPrivateJson } from '../internal/private-file.js';
import { loadBundled } from './bundled.js';
import { pathParameterNames } from '../internal/path-template.js';
import { correctionForDefinitionPath, correctionForPath, requestBodyCorrection } from './corrections.js';
import { parseExtensionCatalog } from './extension.js';

function withCorrectedPath(version, op) {
  const correction = correctionForDefinitionPath(version, op.path);
  if (correction) op = { ...op, key: `${op.method} ${correction.path}`, path: correction.path,
    parameters: [...op.parameters, { name: correction.parameter, in: 'path', required: true, type: 'string' }] };
  const names = pathParameterNames(op.path);
  if (new Set(names).size !== names.length) throw new Error(`catalog operation names a path parameter twice: ${op.key}`);
  return op;
}

export function createCatalog(extensionPath = '', version = 'latest') {
  const { catalog: base, openapi } = loadBundled(version);
  const operations = base.operations.map(op => withCorrectedPath(version, op));
  const byKey = new Map(operations.map(op => [op.key, op]));
  if (!extensionPath) return { operations, byKey, source: base.source, sourceSha256: base.sourceSha256, openapi, version };
  const extension = readPrivateJson(extensionPath, 'KEYCLOAK_MCP_EXTENSION_CATALOG');
  const extra = parseExtensionCatalog(extension);
  const combined = new Map(byKey);
  for (const op of extra) {
    if (combined.has(op.key)) throw new Error(`duplicate extension operation: ${op.key}`);
    combined.set(op.key, op);
  }
  return { operations: [...combined.values()].sort((a, b) => a.key.localeCompare(b.key)), byKey: combined,
    source: `${base.source}; ${extension.source}`, sourceSha256: base.sourceSha256, openapi, version,
    extensionSource: extension.source, extensionCount: extra.length };
}

const configured = new Map();

// The catalog a configuration selects, built once per catalog version and extension file.
export function catalogFor({ catalogVersion = 'latest', extensionCatalogPath = '' }) {
  const key = JSON.stringify([catalogVersion, extensionCatalogPath]);
  if (!configured.has(key)) configured.set(key, createCatalog(extensionCatalogPath, catalogVersion));
  return configured.get(key);
}

// The catalog for key-only callers that pass none: the bundled `latest` definition.
export function defaultCatalog() {
  return catalogFor({});
}

const MAX_PAGE_SIZE = 100;

// Every adapter and the JavaScript API share this contract, so a caller cannot page past the size cap
// or get an empty page from a string offset or a negative limit.
function pageQuery({ search = '', tag = '', method = '', offset = 0, limit = 25 }) {
  for (const [name, value] of Object.entries({ search, tag, method })) if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  return { needle: search.toLowerCase(), tag, method: method.toUpperCase(), offset, limit };
}

export function listOperations(query = {}, operationCatalog = defaultCatalog()) {
  const { needle, tag, method, offset, limit } = pageQuery(query);
  const filtered = operationCatalog.operations.filter(op => (!needle || `${op.key} ${op.summary}`.toLowerCase().includes(needle)) &&
    (!tag || op.tags.includes(tag)) && (!method || op.method === method));
  return { source: operationCatalog.source, sourceSha256: operationCatalog.sourceSha256, extensionCount: operationCatalog.extensionCount ?? 0,
    total: filtered.length, operations: filtered.slice(offset, offset + limit).map(({ key, summary, tags }) => ({ key, summary, tags })) };
}

export function describeOperation(key, operationCatalog = defaultCatalog()) {
  const op = operationCatalog.byKey.get(key);
  if (!op) throw new Error('operation is not in the pinned Keycloak catalog');
  if (op.extension) return op;
  const pathCorrection = correctionForPath(operationCatalog.version, op.path);
  const path = operationCatalog.openapi.paths[pathCorrection?.definitionPath ?? op.path];
  const detail = path?.[op.method.toLowerCase()];
  if (!detail) throw new Error('operation is absent from the bundled OpenAPI definition');
  const correction = requestBodyCorrection(operationCatalog.version, key, detail);
  const correctedParameters = pathCorrection ? [{ name: pathCorrection.parameter, in: 'path', required: true, schema: { type: 'string' } }] : [];
  return {
    ...op,
    parameters: [...(path.parameters ?? []), ...(detail.parameters ?? []), ...correctedParameters],
    requestTypes: correction?.requestTypes ?? op.requestTypes,
    requestBody: detail.requestBody ?? correction?.requestBody ?? null,
    responses: detail.responses ?? {},
  };
}

export function describeSchema(name, operationCatalog = defaultCatalog()) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error('invalid schema name');
  const schema = operationCatalog.openapi.components?.schemas?.[name];
  if (!schema) throw new Error('schema is not in the pinned Keycloak definition');
  return { name, schema };
}
