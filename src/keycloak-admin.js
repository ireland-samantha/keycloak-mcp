import { createCatalog } from './catalog/index.js';
import { buildRequest } from './http/request.js';
import { readResult } from './http/response.js';
import { ServiceAccountToken } from './http/token.js';
import { send } from './http/transport.js';
import { grantExecute } from './internal/capabilities.js';
import { invalidatesServiceToken, isMutation } from './policy/classify.js';

// Calls catalog operations in the configured realm as the configured service account.
// `options` overrides transport timing: { sleep, requestTimeoutMs, tokenTimeoutMs, retryDelaysMs }.
export class KeycloakAdmin {
  #fetch;
  #token;
  #options;

  constructor(config, fetchImpl = globalThis.fetch, options = {}) {
    this.config = config;
    this.catalog = createCatalog(config.extensionCatalogPath, config.catalogVersion);
    this.#fetch = fetchImpl;
    this.#token = new ServiceAccountToken(config, fetchImpl, options);
    this.#options = options;
    grantExecute(this, (key, args) => this.#execute(key, args));
  }

  invalidateToken() {
    this.#token.invalidate();
  }

  token() {
    return this.#token.get();
  }

  async invoke(key, args = {}) {
    if (isMutation(key, this.catalog)) throw new Error('mutations require a compensating workflow');
    return this.#execute(key, args);
  }

  async #execute(key, args = {}) {
    const request = buildRequest(this.config, key, args, this.catalog);
    const { response, attempts } = await send(this.#fetch, this.#token, request,
      { ...this.#options, safeRead: !isMutation(key, this.catalog) });
    if (invalidatesServiceToken(key)) this.invalidateToken();
    return readResult(response, { op: request.op, attempts, config: this.config });
  }
}
