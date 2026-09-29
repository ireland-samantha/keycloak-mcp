import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_BODY_BYTES } from './config.js';
import { pathParameterNames } from './internal/path-template.js';
import { readPrivateJson } from './internal/private-file.js';
import { redactKeys, REDACTED_ENDPOINT } from './internal/redaction.js';

export { configFromEnv } from './config.js';

const catalog = JSON.parse(readFileSync(new URL('../data/operations.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(readFileSync(new URL('../data/openapi.json', import.meta.url), 'utf8'));
const catalog2635 = JSON.parse(readFileSync(new URL('../data/operations-26.3.5.json', import.meta.url), 'utf8'));
const openapi2635 = JSON.parse(readFileSync(new URL('../data/openapi-26.3.5.json', import.meta.url), 'utf8'));
const baseCatalogs = { latest: [catalog, openapi], '26.3.5': [catalog2635, openapi2635] };
const sensitive = /secret|password|credential|private.?key|access.?token|refresh.?token|authorization|^token$/i;
const sideEffectingGets = new Set(['GET /admin/realms/{realm}/identity-provider/instances/{alias}/reload-keys']);
const readOnlyPosts = new Set([
  'POST /admin/realms/{realm}/client-description-converter',
  'POST /admin/realms/{realm}/identity-provider/upload-certificate',
]);
const federatedIdentityCreate = 'POST /admin/realms/{realm}/users/{user-id}/federated-identity/{provider}';
const certificateUploads = new Set([
  'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/upload',
  'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/upload-certificate',
  'POST /admin/realms/{realm}/identity-provider/upload-certificate',
]);
const sensitivePaths = /\/client-secret(?:\/|$)|\/clients-initial-access(?:\/|$)|\/credentials(?:\/|$)|\/certificates\/\{attr\}(?:\/|$)|\/installation\/providers\/|\/evaluate-scopes\/generate-example-/;
const irreversiblePath = /(?:\/logout|\/reset-password|\/send-|\/execute-actions-email|\/client-secret|\/sessions(?:\/|$)|\/brute-force\/users|\/credentials\/|\/disable-credential-types|\/push-revocation|\/testSMTPConnection|\/impersonation|\/clear-|\/members\/invite-|\/identity-provider\/import-config)/;
const irreversibleInvitationResend = /\/invitations\/\{id\}\/resend$/;
const irreversibleWorkflowActions = /\/workflows\/(?:migrate$|\{id\}\/(?:activate|deactivate)\/)/;
async function limitedBody(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    try { await response.body?.cancel(); } catch { /* the limit error remains authoritative */ }
    throw new Error(`response exceeds configured limit (HTTP ${response.status})`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* the limit error remains authoritative */ }
        throw new Error(`response exceeds configured limit (HTTP ${response.status})`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

export function createCatalog(extensionPath = '', version = 'latest') {
  const pair = baseCatalogs[version];
  if (!pair) throw new Error('unsupported KEYCLOAK_MCP_CATALOG_VERSION');
  const [base, spec] = pair;
  const byKey = new Map(base.operations.map(op => [op.key, op]));
  if (!extensionPath) return { operations: base.operations, byKey, source: base.source, sourceSha256: base.sourceSha256, openapi: spec, version };
  const extension = readPrivateJson(extensionPath, 'KEYCLOAK_MCP_EXTENSION_CATALOG');
  if (!extension || !Array.isArray(extension.operations) || typeof extension.source !== 'string') throw new Error('invalid extension catalog');
  const extra = extension.operations.map(item => {
    if (!item || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(item.method) ||
      typeof item.path !== 'string' || !/^\/(?:admin\/)?realms\/\{realm\}(?:\/|$)/.test(item.path) ||
      /[?#\\%:]/.test(item.path) || /\/\.{1,2}(?:\/|$)/.test(item.path) || item.path.includes('//')) throw new Error('invalid extension operation');
    const names = pathParameterNames(item.path);
    if (names.some(name => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))) throw new Error('invalid extension path parameter');
    if (item.method === 'GET' && item.readOnly !== true && item.readOnly !== false) throw new Error('extension GET must declare readOnly');
    if (typeof item.serviceAccountSupported !== 'boolean') throw new Error('extension operation must declare serviceAccountSupported');
    if (!Array.isArray(item.query ?? []) || (item.query ?? []).some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))) throw new Error('invalid extension query');
    if (!Array.isArray(item.tags ?? []) || (item.tags ?? []).some(value => typeof value !== 'string')) throw new Error('invalid extension tags');
    const parameters = [
      ...names.map(name => ({ name, in: 'path', required: true, type: 'string' })),
      ...(item.query ?? []).map(name => ({ name, in: 'query', required: false, type: 'string' })),
    ];
    for (const field of ['requestTypes', 'responseTypes']) if (!Array.isArray(item[field] ?? []) || (item[field] ?? []).some(value => typeof value !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(value))) throw new Error(`invalid extension ${field}`);
    return { key: `${item.method} ${item.path}`, method: item.method, path: item.path,
      summary: item.summary ?? '', description: item.description ?? '', tags: item.tags ?? ['Extension'],
      parameters, requestTypes: item.requestTypes ?? [], responseTypes: item.responseTypes ?? [],
      requestBody: null, responses: {}, extension: true, readOnly: item.readOnly === true,
      irreversible: item.irreversible !== false, serviceAccountSupported: item.serviceAccountSupported };
  });
  const combined = new Map(byKey);
  for (const op of extra) {
    if (combined.has(op.key)) throw new Error(`duplicate extension operation: ${op.key}`);
    combined.set(op.key, op);
  }
  return { operations: [...combined.values()].sort((a, b) => a.key.localeCompare(b.key)), byKey: combined,
    source: `${base.source}; ${extension.source}`, sourceSha256: base.sourceSha256, openapi: spec, version,
    extensionSource: extension.source, extensionCount: extra.length };
}

export function isMutation(key, operationCatalog = createCatalog()) {
  const op = describeOperation(key, operationCatalog);
  return op.extension ? !op.readOnly : (!['GET', 'HEAD'].includes(op.method) && !readOnlyPosts.has(key)) || sideEffectingGets.has(key);
}

export function isIrreversible(key, operationCatalog = createCatalog()) {
  const op = describeOperation(key, operationCatalog);
  if (!isMutation(key, operationCatalog)) return false;
  if (op.method === 'DELETE' || sideEffectingGets.has(key)) return true;
  if (op.extension) return op.irreversible;
  // Bodyless PUT/DELETE pairs create and remove associations. Repeating PUT
  // cannot undo an assignment, and DELETE may remove a pre-existing one.
  if (op.method === 'PUT' && op.requestTypes.length === 0 && operationCatalog.byKey.has(`DELETE ${op.path}`)) return true;
  if (irreversiblePath.test(op.path) || irreversibleInvitationResend.test(op.path) ||
    irreversibleWorkflowActions.test(op.path)) return true;
  return false;
}

export function listOperations({ search = '', tag = '', method = '', offset = 0, limit = 25 } = {}, operationCatalog = createCatalog()) {
  const needle = search.toLowerCase();
  const filtered = operationCatalog.operations.filter(op => (!needle || `${op.key} ${op.summary}`.toLowerCase().includes(needle)) && (!tag || op.tags.includes(tag)) && (!method || op.method === method.toUpperCase()));
  return { source: operationCatalog.source, sourceSha256: operationCatalog.sourceSha256, extensionCount: operationCatalog.extensionCount ?? 0, total: filtered.length, operations: filtered.slice(offset, offset + Math.min(limit, 100)).map(({ key, summary, tags }) => ({ key, summary, tags })) };
}

export function describeOperation(key, operationCatalog = createCatalog()) {
  const op = operationCatalog.byKey.get(key);
  if (!op) throw new Error('operation is not in the pinned Keycloak catalog');
  if (op.extension) return op;
  const path = operationCatalog.openapi.paths[op.path];
  const detail = path?.[op.method.toLowerCase()];
  if (!detail) throw new Error('operation is absent from the bundled OpenAPI definition');
  // The 26.3.5 OpenAPI omits the JSON body consumed by UserResource.addFederatedIdentity.
  const correctedBody = operationCatalog.version === '26.3.5' && key === federatedIdentityCreate && !detail.requestBody
    ? { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FederatedIdentityRepresentation' } } } }
    : null;
  // The bundled OpenAPI definitions omit the multipart bodies consumed by these certificate routes.
  const multipartBody = certificateUploads.has(key) && !detail.requestBody
    ? { required: true, content: { 'multipart/form-data': { schema: { type: 'object',
      required: ['keystoreFormat', 'file'], properties: {
        keystoreFormat: { type: 'string' }, file: { type: 'string', format: 'binary' },
        keyAlias: { type: 'string' }, keyPassword: { type: 'string' }, storePassword: { type: 'string' },
      } } } } }
    : null;
  return {
    ...op,
    parameters: [...(path.parameters ?? []), ...(detail.parameters ?? [])],
    requestTypes: correctedBody ? ['application/json'] : multipartBody ? ['multipart/form-data'] : op.requestTypes,
    requestBody: detail.requestBody ?? correctedBody ?? multipartBody,
    responses: detail.responses ?? {},
  };
}

export function describeSchema(name, operationCatalog = createCatalog()) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error('invalid schema name');
  const schema = operationCatalog.openapi.components?.schemas?.[name];
  if (!schema) throw new Error('schema is not in the pinned Keycloak definition');
  return { name, schema };
}

function decodeBase64Bounded(value, limit, label) {
  if (typeof value !== 'string') throw new Error(`invalid ${label}`);
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (Math.floor(value.length / 4) * 3 - padding > limit) throw new Error('request body exceeds configured limit');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`invalid ${label}`);
  return Buffer.from(value, 'base64');
}

function encodeMultipart(fields, limit) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 32)
    throw new Error('multipart body must be an object with at most 32 fields');
  const form = new FormData();
  let bytes = 1024;
  for (const [name, value] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('invalid multipart field name');
    bytes += 1024 + Buffer.byteLength(name);
    if (bytes > limit) throw new Error('request body exceeds configured limit');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value);
      if (bytes > limit) throw new Error('request body exceeds configured limit');
      form.append(name, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const { filename, contentType, base64 } = value;
      if (Object.keys(value).some(key => !['filename', 'contentType', 'base64'].includes(key)) ||
        typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename)) throw new Error('invalid multipart filename');
      if (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new Error('invalid multipart content type');
      bytes += Buffer.byteLength(filename) + Buffer.byteLength(contentType);
      if (bytes > limit) throw new Error('request body exceeds configured limit');
      const file = decodeBase64Bounded(base64, limit - bytes, 'multipart base64');
      bytes += file.length;
      form.append(name, new Blob([file], { type: contentType }), filename);
    } else throw new Error('multipart fields must be text or a base64 file');
    if (bytes > limit) throw new Error('request body exceeds configured limit');
  }
  return form;
}

export function buildRequest(config, key, args = {}, operationCatalog = createCatalog()) {
  const op = describeOperation(key, operationCatalog);
  if (op.extension && !op.serviceAccountSupported) throw new Error('extension operation requires a non-service-account credential');
  if (isMutation(key, operationCatalog) && !config.allowWrite) throw new Error('writes are disabled');
  if (!op.path.includes('{realm}') && isMutation(key, operationCatalog) && !config.allowRealmAdmin) throw new Error('realm administration is disabled');
  const inputPath = args.path ?? {};
  const names = pathParameterNames(op.path);
  if (Object.keys(inputPath).some(name => !names.includes(name))) throw new Error('unknown path parameter');
  const path = op.path.replace(/\{([^}]+)\}/g, (_match, name) => {
    const value = name === 'realm' ? config.realm : inputPath[name];
    if (value === undefined || value === null || String(value) === '') throw new Error(`missing path parameter: ${name}`);
    if (name === 'realm' && inputPath.realm !== undefined && inputPath.realm !== config.realm) throw new Error('realm cannot be overridden');
    if (name === 'path') {
      const segments = String(value).replace(/^\//, '').split('/');
      if (segments.some(segment => !segment || ['.', '..'].includes(segment) || segment.includes('\\'))) throw new Error('unsafe group path');
      return segments.map(encodeURIComponent).join('/');
    }
    if (['.', '..'].includes(String(value)) || /[\\/]/.test(String(value))) throw new Error(`unsafe path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
  const url = new URL(`${config.baseUrl}${path}`);
  const allowedQuery = new Set(op.parameters.filter(p => p.in === 'query').map(p => p.name));
  for (const [name, value] of Object.entries(args.query ?? {})) {
    if (!allowedQuery.has(name)) throw new Error(`unknown query parameter: ${name}`);
    for (const item of Array.isArray(value) ? value : [value]) if (item !== null && item !== undefined) url.searchParams.append(name, String(item));
  }
  let body;
  const headers = {};
  if (args.body !== undefined || args.bodyBase64 !== undefined) {
    if (!op.requestTypes.length) throw new Error('operation does not declare a request body');
    const contentType = args.contentType ?? op.requestTypes[0];
    if (!op.requestTypes.includes(contentType)) throw new Error('content type is not declared for this operation');
    if (args.body !== undefined && args.bodyBase64 !== undefined) throw new Error('choose body or bodyBase64');
    if (contentType === 'multipart/form-data') {
      if (args.bodyBase64 !== undefined) throw new Error('multipart requires structured fields');
      body = encodeMultipart(args.body, config.maxBodyBytes ?? DEFAULT_BODY_BYTES);
    } else if (args.bodyBase64 !== undefined) {
      body = decodeBase64Bounded(args.bodyBase64, config.maxBodyBytes ?? DEFAULT_BODY_BYTES, 'base64 body');
    } else if (contentType === 'application/json') body = JSON.stringify(args.body);
    else if (contentType === 'application/x-www-form-urlencoded') {
      if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) throw new Error('form body must be an object');
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(args.body)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error('form values must be scalar');
          form.append(name, String(item));
        }
      }
      body = form.toString();
    }
    else if (typeof args.body === 'string') body = args.body;
    else throw new Error('non-JSON bodies require text or bodyBase64');
    if (!(body instanceof FormData) && Buffer.byteLength(body) > (config.maxBodyBytes ?? DEFAULT_BODY_BYTES)) throw new Error('request body exceeds configured limit');
    if (!(body instanceof FormData)) headers['content-type'] = contentType;
  }
  if (args.accept) {
    if (!op.responseTypes.includes(args.accept)) throw new Error('accept type is not declared for this operation');
    headers.accept = args.accept;
  }
  return { op, url: url.toString(), body, headers };
}

export class KeycloakAdmin {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.catalog = createCatalog(config.extensionCatalogPath, config.catalogVersion);
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  invalidateToken() {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 30_000) return this.accessToken;
    const { baseUrl, authRealm, clientId, clientSecret } = this.config;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const response = await this.fetch(`${baseUrl}/realms/${encodeURIComponent(authRealm)}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* report the HTTP failure */ }
      throw new Error(`Keycloak service-account token request failed (HTTP ${response.status})`);
    }
    const tokenBytes = await limitedBody(response, 64 * 1024);
    let data;
    try { data = JSON.parse(tokenBytes.toString('utf8')); }
    catch { throw new Error('Keycloak token response is invalid JSON'); }
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Keycloak token response is incomplete');
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  async invoke(key, args = {}) {
    if (isMutation(key, this.catalog)) throw new Error('mutations require a compensating workflow');
    return this._invoke(key, args);
  }

  async _invoke(key, args = {}) {
    const req = buildRequest(this.config, key, args, this.catalog);
    let token = await this.token();
    const safeRead = !isMutation(key, this.catalog);
    let response;
    let attempts = 0;
    let transientRetries = 0;
    let authRefreshed = false;
    while (true) {
      attempts += 1;
      response = await this.fetch(req.url, {
        method: req.op.method, headers: { ...req.headers, authorization: `Bearer ${token}` },
        ...(req.body === undefined ? {} : { body: req.body }), redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) break;
      try { await response.body?.cancel(); } catch { /* report the HTTP failure */ }
      if (response.status === 401) {
        if (this.accessToken === token) this.invalidateToken();
        if (safeRead && req.op.method === 'GET' && !authRefreshed) {
          authRefreshed = true;
          token = await this.token();
          continue;
        }
      }
      if (!safeRead || transientRetries >= 2 || ![502, 503, 504].includes(response.status))
        throw new Error(`Keycloak operation failed (HTTP ${response.status}; attempts ${attempts})`);
      transientRetries += 1;
      await delay(transientRetries === 1 ? 150 : 400);
    }
    if (key === 'POST /admin/realms/{realm}/logout-all') this.invalidateToken();
    const bytes = await limitedBody(response, this.config.maxBodyBytes ?? DEFAULT_BODY_BYTES);
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    let value = null;
    if (bytes.length && sensitivePaths.test(req.op.path) && !this.config.allowSensitiveReads) value = REDACTED_ENDPOINT;
    else if (bytes.length && contentType.includes('json')) {
      try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Keycloak returned invalid JSON'); }
      if (!this.config.allowSensitiveReads) {
        const redactRepresentation = req.op.path === '/admin/realms/{realm}/admin-events';
        value = redactKeys(value, key => sensitive.test(key) || (redactRepresentation && key === 'representation'));
      }
    } else if (bytes.length && (contentType.startsWith('text/') || contentType.includes('xml') || contentType.includes('yaml'))) value = bytes.toString('utf8');
    else if (bytes.length) value = { base64: bytes.toString('base64'), contentType };
    const location = response.headers.get('location');
    return { status: response.status, ...(attempts > 1 ? { attempts } : {}), ...(location ? { location } : {}), value };
  }
}
