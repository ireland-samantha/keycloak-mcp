import { setTimeout as delay } from 'node:timers/promises';
import { createCatalog } from './catalog/index.js';
import { DEFAULT_BODY_BYTES } from './config.js';
import { discardBody, readLimitedBody } from './http/body.js';
import { buildRequest } from './http/request.js';
import { redactKeys, REDACTED_ENDPOINT } from './internal/redaction.js';
import { invalidatesServiceToken, isMutation, isSensitiveEndpoint, isSensitiveField } from './policy/classify.js';

export { configFromEnv } from './config.js';
export { createCatalog, describeOperation, describeSchema, listOperations } from './catalog/index.js';
export { isIrreversible, isMutation } from './policy/classify.js';
export { buildRequest } from './http/request.js';

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
      await discardBody(response);
      throw new Error(`Keycloak service-account token request failed (HTTP ${response.status})`);
    }
    const tokenBytes = await readLimitedBody(response, 64 * 1024);
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
      await discardBody(response);
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
    if (invalidatesServiceToken(key)) this.invalidateToken();
    const bytes = await readLimitedBody(response, this.config.maxBodyBytes ?? DEFAULT_BODY_BYTES);
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    let value = null;
    if (bytes.length && isSensitiveEndpoint(req.op) && !this.config.allowSensitiveReads) value = REDACTED_ENDPOINT;
    else if (bytes.length && contentType.includes('json')) {
      try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Keycloak returned invalid JSON'); }
      if (!this.config.allowSensitiveReads) value = redactKeys(value, name => isSensitiveField(req.op, name));
    } else if (bytes.length && (contentType.startsWith('text/') || contentType.includes('xml') || contentType.includes('yaml'))) value = bytes.toString('utf8');
    else if (bytes.length) value = { base64: bytes.toString('base64'), contentType };
    const location = response.headers.get('location');
    return { status: response.status, ...(attempts > 1 ? { attempts } : {}), ...(location ? { location } : {}), value };
  }
}
