import { existsSync, readFileSync } from 'node:fs';
import { pathParameterNames, withoutParameterNames } from '../internal/path-template.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
// Literal segments and whole-segment parameters only, so no dot segment, empty segment or URL syntax.
const ADMIN_PATH = /^\/admin(?:\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_-]*\}))+$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const LOCATIONS = ['path', 'query'];
const loaded = new Map();

// data/admin-client-supplement-<version>.json, or null when that version has none. The Java equivalence
// module generates it (mvn -f equivalence/pom.xml -Psupplement); DESIGN §3 defines its format. Callers
// pass a version the bundled catalogs already accepted.
export function loadSupplement(version) {
  if (!loaded.has(version)) {
    const file = new URL(`../../data/admin-client-supplement-${version}.json`, import.meta.url);
    loaded.set(version, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  }
  return loaded.get(version);
}

const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const isSchema = value => value === null || (typeof value === 'object' && !Array.isArray(value));

function invalid(item, reason) {
  return new Error(`invalid admin-client supplement operation ${JSON.stringify(item?.key)}: ${reason}`);
}

function parseParameters(item) {
  if (!Array.isArray(item.parameters)) throw invalid(item, 'parameters');
  const parameters = item.parameters.map(({ name, in: location, required, type }) => {
    if (typeof name !== 'string' || !LOCATIONS.includes(location) || typeof required !== 'boolean' || typeof type !== 'string') throw invalid(item, 'parameter');
    return { name, in: location, required, type };
  });
  const declared = parameters.filter(parameter => parameter.in === 'path').map(parameter => parameter.name);
  const names = pathParameterNames(item.path);
  if (new Set(names).size !== names.length || declared.length !== names.length || !names.every(name => declared.includes(name)))
    throw invalid(item, 'path parameters must match the path, each named once');
  return parameters;
}

const content = (types, schema) => Object.fromEntries(types.map(type => [type, { schema }]));

function parseOperation(item) {
  if (!item || !METHODS.includes(item.method) || typeof item.path !== 'string' || !ADMIN_PATH.test(item.path)) throw invalid(item, 'method or path');
  if (item.key !== `${item.method} ${item.path}`) throw invalid(item, 'key must be "METHOD path"');
  for (const field of ['summary', 'description']) if (typeof item[field] !== 'string') throw invalid(item, field);
  for (const field of ['tags', 'adminClient']) if (!isStringList(item[field])) throw invalid(item, field);
  for (const field of ['requestTypes', 'responseTypes'])
    if (!isStringList(item[field]) || !item[field].every(type => MEDIA_TYPE.test(type))) throw invalid(item, field);
  if (!isSchema(item.requestSchema) || !isSchema(item.responseSchema)) throw invalid(item, 'schemas');
  const { key, method, path, summary, description, tags, requestTypes, responseTypes, requestSchema, responseSchema, adminClient } = item;
  return {
    key, method, path, summary, description, tags, parameters: parseParameters(item), requestTypes, responseTypes,
    requestBody: requestSchema && requestTypes.length ? { required: true, content: content(requestTypes, requestSchema) } : null,
    // A response without a declared media type comes in whatever type Keycloak chooses.
    responses: responseSchema ? { '2XX': { description: 'Success', content: content(responseTypes.length ? responseTypes : ['*/*'], responseSchema) } } : {},
    origin: 'admin-client', adminClient,
  };
}

const route = op => `${op.method} ${withoutParameterNames(op.path)}`;

// The catalog with the supplement's operations added. An operation whose route the catalog already has,
// under any parameter names, means the supplement was generated against another definition.
export function withSupplement(catalog, supplement) {
  if (!supplement || !Array.isArray(supplement.operations) || typeof supplement.source !== 'string' || !isSchema(supplement.schemas ?? {}))
    throw new Error('invalid admin-client supplement');
  const operations = supplement.operations.map(parseOperation);
  const routes = new Set(catalog.operations.map(route));
  const byKey = new Map(catalog.byKey);
  for (const op of operations) {
    if (routes.has(route(op))) throw new Error(`admin-client supplement repeats a catalog operation: ${op.key}; regenerate data/admin-client-supplement-${catalog.version}.json with mvn -f equivalence/pom.xml -Psupplement`);
    routes.add(route(op));
    byKey.set(op.key, op);
  }
  const { source, resolvedVersion, sourceSha256, scmRevision, openapiSha256, schemas = {} } = supplement;
  return {
    ...catalog, operations: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)), byKey,
    source: `${catalog.source}; ${source} (${resolvedVersion})`,
    supplement: { source, resolvedVersion, sourceSha256, scmRevision, openapiSha256, count: operations.length, schemas },
  };
}
