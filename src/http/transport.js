import { setTimeout as delay } from 'node:timers/promises';
import { discardBody } from './body.js';

const TRANSIENT_STATUSES = [502, 503, 504];

const unsent = new WeakSet();

// Whether `error` ended a call before its request left keycloak-mcp, as a failed token grant does, so
// the operation did not run. The error itself is passed on unchanged.
export const wasNotSent = error => unsent.has(error);

async function firstBearer(token) {
  try {
    return await token.get();
  } catch (error) {
    unsent.add(error);
    throw error;
  }
}

// Sends a built request with the service-account token and returns { response, attempts } for the first
// successful response or for the failure that ends the attempts. Only a safe read is repeated: after a
// transient 5xx, once per entry of retryDelaysMs, and once with a fresh token after a GET is refused
// with 401. A mutation is sent once, because a failed response may follow a committed change. Redirects
// are returned, not followed.
export async function send(fetchImpl, token, request,
  { safeRead, sleep = delay, requestTimeoutMs = 30_000, retryDelaysMs = [150, 400] }) {
  let bearer = await firstBearer(token);
  let attempts = 0;
  let transientRetries = 0;
  let authRefreshed = false;
  while (true) {
    attempts += 1;
    const response = await fetchImpl(request.url, {
      method: request.op.method, headers: { ...request.headers, authorization: `Bearer ${bearer}` },
      ...(request.body === undefined ? {} : { body: request.body }), redirect: 'manual', signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.ok) return { response, attempts };
    if (response.status === 401) token.invalidateIfCurrent(bearer);
    const refreshToken = response.status === 401 && safeRead && request.op.method === 'GET' && !authRefreshed;
    const retryTransient = safeRead && transientRetries < retryDelaysMs.length && TRANSIENT_STATUSES.includes(response.status);
    if (!refreshToken && !retryTransient) return { response, attempts };
    await discardBody(response);
    if (refreshToken) {
      authRefreshed = true;
      bearer = await token.get();
    } else {
      await sleep(retryDelaysMs[transientRetries]);
      transientRetries += 1;
    }
  }
}
