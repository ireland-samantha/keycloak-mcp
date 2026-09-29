import { readPrivateJson } from '../internal/private-file.js';
import { loadBundled } from './bundled.js';
import { requestBodyCorrection } from './corrections.js';
import { parseExtensionCatalog } from './extension.js';

export function createCatalog(extensionPath = '', version = 'latest') {
  const { catalog: base, openapi } = loadBundled(version);
  const byKey = new Map(base.operations.map(op => [op.key, op]));
  if (!extensionPath) return { operations: base.operations, byKey, source: base.source, sourceSha256: base.sourceSha256, openapi, version };
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

let bundledLatest;

// The catalog for callers that pass none: the bundled `latest` definition, built once.
export function defaultCatalog() {
  bundledLatest ??= createCatalog();
  return bundledLatest;
}

export function listOperations({ search = '', tag = '', method = '', offset = 0, limit = 25 } = {}, operationCatalog = defaultCatalog()) {
  const needle = search.toLowerCase();
  const filtered = operationCatalog.operations.filter(op => (!needle || `${op.key} ${op.summary}`.toLowerCase().includes(needle)) &&
    (!tag || op.tags.includes(tag)) && (!method || op.method === method.toUpperCase()));
  return { source: operationCatalog.source, sourceSha256: operationCatalog.sourceSha256, extensionCount: operationCatalog.extensionCount ?? 0,
    total: filtered.length, operations: filtered.slice(offset, offset + Math.min(limit, 100)).map(({ key, summary, tags }) => ({ key, summary, tags })) };
}

export function describeOperation(key, operationCatalog = defaultCatalog()) {
  const op = operationCatalog.byKey.get(key);
  if (!op) throw new Error('operation is not in the pinned Keycloak catalog');
  if (op.extension) return op;
  const path = operationCatalog.openapi.paths[op.path];
  const detail = path?.[op.method.toLowerCase()];
  if (!detail) throw new Error('operation is absent from the bundled OpenAPI definition');
  const correction = requestBodyCorrection(operationCatalog.version, key, detail);
  return {
    ...op,
    parameters: [...(path.parameters ?? []), ...(detail.parameters ?? [])],
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
