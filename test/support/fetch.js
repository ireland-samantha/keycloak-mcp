export function jsonResponse(status, value, headers = {}) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

export function tokenResponse(accessToken = 'token', expiresIn = 900) {
  return jsonResponse(200, { access_token: accessToken, expires_in: expiresIn });
}

// A fetch stand-in for Keycloak: token requests get `token()`, everything else `handler()`.
// A Response body can be consumed once, and cancelling a clone's body never settles, so a
// handler that returns the same Response twice is a test bug and fails loudly.
export function fakeKeycloak(handler, { token = () => tokenResponse() } = {}) {
  const served = new WeakSet();
  return async (url, options) => {
    const response = await (url.endsWith('/token') ? token(url, options) : handler(url, options));
    if (served.has(response)) throw new Error('fake Keycloak returned the same Response twice');
    served.add(response);
    return response;
  };
}

// Routes are [pattern, respond] pairs matched in order against "METHOD /path".
export function routeTable(routes, fallback = () => jsonResponse(599, {})) {
  return (url, options) => {
    const request = `${options.method} ${new URL(url).pathname}`;
    const route = routes.find(([pattern]) => new RegExp(pattern).test(request));
    return route ? route[1](url, options) : fallback(url, options);
  };
}
