import { readLimitedBody } from './body.js';
import { errorDetail } from './response.js';

const REFRESH_BEFORE_EXPIRY_MS = 30_000;
const TOKEN_RESPONSE_LIMIT = 64 * 1024;

// RFC 6749 section 2.3.1 form-encodes client_id and client_secret before HTTP Basic, and Keycloak
// URL-decodes both halves (core/src/main/java/org/keycloak/util/BasicAuthHelper.java:79-93, called from
// ClientIdAndSecretAuthenticator.java:76): unencoded, '+' would arrive as a space and a ':' in the
// client ID would split it.
const formEncode = value => encodeURIComponent(value).replace(/%20/g, '+');

// The configured service account's client_credentials token. It is refreshed 30 s before it expires,
// or halfway through its lifetime when that is shorter, and concurrent callers share one grant.
export class ServiceAccountToken {
  #config;
  #fetch;
  #timeoutMs;
  #now;
  #value = null;
  #refreshAt = 0;
  #pending = null;
  // Bumped by invalidate(), so a grant requested before it cannot be cached after it.
  #generation = 0;

  constructor(config, fetchImpl, { tokenTimeoutMs = 15_000, now = Date.now } = {}) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#timeoutMs = tokenTimeoutMs;
    this.#now = now;
  }

  invalidate() {
    this.#value = null;
    this.#refreshAt = 0;
    this.#pending = null;
    this.#generation += 1;
  }

  // Keeps a token another call has fetched since `token` was handed out.
  invalidateIfCurrent(token) {
    if (this.#value === token) this.invalidate();
  }

  get() {
    if (this.#value && this.#now() < this.#refreshAt) return Promise.resolve(this.#value);
    this.#pending ??= this.#grantForGeneration(this.#generation);
    return this.#pending;
  }

  async #grantForGeneration(generation) {
    try {
      const { token, lifetimeMs } = await this.#grant();
      if (generation === this.#generation) {
        this.#value = token;
        this.#refreshAt = this.#now() + lifetimeMs - Math.min(REFRESH_BEFORE_EXPIRY_MS, lifetimeMs / 2);
      }
      return token;
    } finally {
      if (generation === this.#generation) this.#pending = null;
    }
  }

  async #grant() {
    const { baseUrl, authRealm, clientId, clientSecret } = this.#config;
    const credentials = Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, 'utf8').toString('base64');
    const response = await this.#fetch(`${baseUrl}/realms/${encodeURIComponent(authRealm)}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }), redirect: 'manual', signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const detail = await errorDetail(response, this.#config);
      throw new Error(`Keycloak service-account token request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
    }
    const tokenBytes = await readLimitedBody(response, TOKEN_RESPONSE_LIMIT);
    let data;
    try { data = JSON.parse(tokenBytes.toString('utf8')); }
    catch { throw new Error('Keycloak token response is invalid JSON'); }
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Keycloak token response is incomplete');
    return { token: data.access_token, lifetimeMs: data.expires_in * 1000 };
  }
}
