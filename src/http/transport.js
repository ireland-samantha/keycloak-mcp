import { setTimeout as delay } from 'node:timers/promises';
import { discardBody } from './body.js';

const TRANSIENT_STATUSES = [502, 503, 504];

// Sends a built request with the service-account token and returns the first successful response.
// Only a safe read is repeated: after a transient 5xx, once per entry of retryDelaysMs, and once with a
// fresh token after a GET is refused with 401. A mutation is sent once, because a failed response
// may follow a committed change.
export async function send(fetchImpl, token, request,
  { safeRead, sleep = delay, requestTimeoutMs = 30_000, retryDelaysMs = [150, 400] }) {
  let bearer = await token.get();
  let attempts = 0;
  let transientRetries = 0;
  let authRefreshed = false;
  while (true) {
    attempts += 1;
    const response = await fetchImpl(request.url, {
      method: request.op.method, headers: { ...request.headers, authorization: `Bearer ${bearer}` },
      ...(request.body === undefined ? {} : { body: request.body }), redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.ok) return { response, attempts };
    await discardBody(response);
    if (response.status === 401) {
      token.invalidateIfCurrent(bearer);
      if (safeRead && request.op.method === 'GET' && !authRefreshed) {
        authRefreshed = true;
        bearer = await token.get();
        continue;
      }
    }
    if (!safeRead || transientRetries >= retryDelaysMs.length || !TRANSIENT_STATUSES.includes(response.status))
      throw new Error(`Keycloak operation failed (HTTP ${response.status}; attempts ${attempts})`);
    await sleep(retryDelaysMs[transientRetries]);
    transientRetries += 1;
  }
}
