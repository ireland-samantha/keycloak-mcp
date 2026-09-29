import { discardBody, readLimitedBody } from './body.js';

const REFRESH_BEFORE_EXPIRY_MS = 30_000;
const TOKEN_RESPONSE_LIMIT = 64 * 1024;

// The configured service account's client_credentials token, cached until shortly before it expires.
export class ServiceAccountToken {
  #config;
  #fetch;
  #timeoutMs;
  #value = null;
  #expiresAt = 0;

  constructor(config, fetchImpl, { tokenTimeoutMs = 15_000 } = {}) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#timeoutMs = tokenTimeoutMs;
  }

  invalidate() {
    this.#value = null;
    this.#expiresAt = 0;
  }

  // Keeps a token another call has fetched since `token` was handed out.
  invalidateIfCurrent(token) {
    if (this.#value === token) this.invalidate();
  }

  async get() {
    if (this.#value && Date.now() < this.#expiresAt - REFRESH_BEFORE_EXPIRY_MS) return this.#value;
    const { baseUrl, authRealm, clientId, clientSecret } = this.#config;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const response = await this.#fetch(`${baseUrl}/realms/${encodeURIComponent(authRealm)}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }), redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      await discardBody(response);
      throw new Error(`Keycloak service-account token request failed (HTTP ${response.status})`);
    }
    const tokenBytes = await readLimitedBody(response, TOKEN_RESPONSE_LIMIT);
    let data;
    try { data = JSON.parse(tokenBytes.toString('utf8')); }
    catch { throw new Error('Keycloak token response is invalid JSON'); }
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Keycloak token response is incomplete');
    this.#value = data.access_token;
    this.#expiresAt = Date.now() + data.expires_in * 1000;
    return this.#value;
  }
}
