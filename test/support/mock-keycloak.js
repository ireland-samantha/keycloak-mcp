import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Default bodies recorded from a Keycloak HEAD server by scripts/record-mock-fixtures.mjs.
const recorded = JSON.parse(readFileSync(new URL('../mock/fixtures/keycloak-head.json', import.meta.url), 'utf8'));
export const fixtureProvenance = recorded.provenance;
const recordedExpiresIn = recorded.responses['token.ok'].body.expires_in;

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "METHOD /path/{param}" → matcher; {realm} only matches the pinned realm, other parameters one segment.
function compileRoute(route, realm) {
  const [method, template] = route.split(' ');
  const pattern = template.split(/(\{[^}]+\})/).map(part => part === '{realm}' ? escapeRegExp(encodeURIComponent(realm))
    : part.startsWith('{') ? '[^/]+' : escapeRegExp(part)).join('');
  const regex = new RegExp(`^${pattern}$`);
  return request => request.method === method && regex.test(request.path);
}

// Keycloak form-decodes both halves of client credentials sent with HTTP Basic, as RFC 6749 §2.3.1
// requires (core/src/main/java/org/keycloak/util/BasicAuthHelper.java:79-88, used by
// services/.../authenticators/client/ClientIdAndSecretAuthenticator.java:76).
function basicCredentials(header = '') {
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const formDecode = text => decodeURIComponent(text.replace(/\+/g, ' '));
  try { return [formDecode(decoded.slice(0, separator)), formDecode(decoded.slice(separator + 1))]; } catch { return null; }
}

class RecordedRequest {
  constructor(incoming, body) {
    const url = new URL(incoming.url, 'http://mock.invalid');
    this.method = incoming.method;
    this.path = url.pathname;
    this.query = url.searchParams;
    this.headers = incoming.headers;
    this.body = body;
    this.receivedAt = performance.now();
    this.closedEarly = false;
  }
  get key() { return `${this.method} ${this.path}`; }
  text() { return this.body.toString('utf8'); }
  json() { return JSON.parse(this.text()); }
  form() { return new URLSearchParams(this.text()); }
}

function fillPlaceholders(value, origin, realm) {
  if (typeof value === 'string') return value.replaceAll('{origin}', origin).replaceAll('{realm}', realm);
  if (Array.isArray(value)) return value.map(item => fillPlaceholders(item, origin, realm));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fillPlaceholders(child, origin, realm)]));
  return value;
}

class MockKeycloak {
  constructor({ realm, authRealm, clientId, clientSecret, expiresIn }) {
    Object.assign(this, { realm, authRealm, clientId, clientSecret, expiresIn });
    this.requests = [];
    this.routes = [];
    this.tokenResponses = [];
    this.issuedTokens = new Set();
    this.tokenCount = 0;
    this.defaults = defaultRoutes.map(([route, respond]) => ({ matches: compileRoute(route, realm), respond }));
    this.server = createServer((incoming, outgoing) => { void this.#handle(incoming, outgoing); });
  }

  async listen() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async close() {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, 'close');
  }

  get tokenPath() { return `/realms/${encodeURIComponent(this.authRealm)}/protocol/openid-connect/token`; }
  get realmPath() { return `/admin/realms/${encodeURIComponent(this.realm)}`; }
  tokenRequests() { return this.requests.filter(request => request.path.endsWith('/protocol/openid-connect/token')); }
  adminRequests() { return this.requests.filter(request => !request.path.endsWith('/protocol/openid-connect/token')); }
  location(path) { return `${this.origin}${path}`; }
  created(path) { return { status: 201, headers: { location: this.location(path) } }; }

  // Responses are served in order; the last one repeats. A response is a spec object or a
  // function (request, mock) returning one, or a promise of one: { status, headers, json | body | stream, hold }.
  // `json` may be a string to send exact JSON text; `stream` is { chunks, chunkBytes, intervalMs }.
  // `hold: true` sends only the status and headers and keeps the response open until the client hangs up.
  on(route, ...responses) {
    this.routes.unshift({ matches: compileRoute(route, this.realm), responses });
    return this;
  }

  onToken(...responses) {
    this.tokenResponses = responses;
    return this;
  }

  revokeTokens() { this.issuedTokens.clear(); }

  // A recorded Keycloak response with its {origin} and {realm} placeholders filled in.
  fixture(name) {
    const { status, headers: recordedHeaders, body: recordedBody } = recorded.responses[name];
    const [headers, body] = fillPlaceholders([recordedHeaders, recordedBody], this.origin, this.realm);
    if (body === null) return { status, headers };
    return { status, headers, ...(headers['content-type']?.includes('json') ? { json: body } : { body }) };
  }

  async #handle(incoming, outgoing) {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new RecordedRequest(incoming, Buffer.concat(chunks));
    this.requests.push(request);
    // Settles once the response is over; closedEarly marks a client that hung up before the end.
    request.settled = new Promise(resolve => outgoing.on('close', () => {
      if (!outgoing.writableFinished) request.closedEarly = true;
      resolve();
    }));
    try {
      await this.#respond(outgoing, request, await this.#resolve(request));
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(599, { 'content-type': 'text/plain' });
      outgoing.end(`mock failure: ${error.message}`);
    }
  }

  async #resolve(request) {
    if (request.path === this.tokenPath && request.method === 'POST') return this.#tokenResponse(request);
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    if (!this.issuedTokens.has(bearer)) return this.fixture('admin.unauthorized');
    const route = this.routes.find(candidate => candidate.matches(request));
    if (!route) return (this.defaults.find(candidate => candidate.matches(request))?.respond ?? defaultResponse)(this, request);
    const next = route.responses.length > 1 ? route.responses.shift() : route.responses[0];
    return typeof next === 'function' ? next(request, this) : next;
  }

  #tokenResponse(request) {
    if (this.tokenResponses.length) {
      const next = this.tokenResponses.length > 1 ? this.tokenResponses.shift() : this.tokenResponses[0];
      return typeof next === 'function' ? next(request, this) : next;
    }
    const [id, secret] = basicCredentials(request.headers.authorization) ?? [];
    if (request.form().get('grant_type') !== 'client_credentials' || id !== this.clientId || secret !== this.clientSecret)
      return this.fixture('token.invalidClient');
    return this.issueToken();
  }

  issueToken({ expiresIn = this.expiresIn } = {}) {
    this.tokenCount += 1;
    const accessToken = `mock-access-token-${this.tokenCount}`;
    this.issuedTokens.add(accessToken);
    const recordedToken = this.fixture('token.ok');
    return { ...recordedToken, json: { ...recordedToken.json, access_token: accessToken, expires_in: expiresIn } };
  }

  async #respond(outgoing, request, { status = 200, headers = {}, json, body, stream, hold = false } = {}) {
    if (json !== undefined) {
      headers = { 'content-type': 'application/json', ...headers };
      body = typeof json === 'string' ? json : JSON.stringify(json);
    }
    outgoing.writeHead(status, headers);
    if (stream) {
      for (let index = 0; index < stream.chunks && !request.closedEarly; index += 1) {
        outgoing.write(Buffer.alloc(stream.chunkBytes, 0x61));
        await delay(stream.intervalMs ?? 5);
      }
      return outgoing.end();
    }
    if (hold) {
      outgoing.flushHeaders();
      return request.settled;
    }
    outgoing.end(body);
  }
}

const createdAt = (mock, request, id) => mock.created(`${request.path}/${encodeURIComponent(id)}`);

// What an otherwise unprogrammed mock answers, shaped after the recorded HEAD responses.
const defaultRoutes = [
  ['GET /admin/realms/{realm}', mock => mock.fixture('realm.get')],
  ['GET /admin/realms/{realm}/users', mock => mock.fixture('users.list')],
  ['GET /admin/realms/{realm}/users/count', mock => mock.fixture('users.count')],
  ['GET /admin/realms/{realm}/users/{id}', mock => mock.fixture('user.notFound')],
  ['GET /admin/realms/{realm}/users/{id}/credentials', mock => mock.fixture('user.credentials')],
  ['GET /admin/realms/{realm}/groups', mock => mock.fixture('groups.list')],
  ['GET /admin/realms/{realm}/clients', mock => mock.fixture('clients.list')],
  ['GET /admin/realms/{realm}/clients/{id}', mock => mock.fixture('client.get')],
  ['GET /admin/realms/{realm}/clients/{id}/client-secret', mock => mock.fixture('client.secret')],
  ['GET /admin/realms/{realm}/clients/{id}/installation/providers/keycloak-oidc-keycloak-json', mock => mock.fixture('client.installation.json')],
  ['GET /admin/realms/{realm}/clients/{id}/installation/providers/keycloak-oidc-jboss-subsystem', mock => mock.fixture('client.installation.xml')],
  ['GET /admin/realms/{realm}/clients/{id}/certificates/{attr}', mock => mock.fixture('client.certificate')],
  ['GET /admin/realms/{realm}/clients/{id}/evaluate-scopes/generate-example-access-token', mock => mock.fixture('example.accessToken')],
  ['GET /admin/realms/{realm}/clients-initial-access', mock => mock.fixture('initialAccess.list')],
  ['GET /admin/realms/{realm}/admin-events', mock => mock.fixture('adminEvents.list')],
  ['GET /admin/realms/{realm}/events/config', mock => mock.fixture('events.config')],
  ['GET /admin/realms/{realm}/identity-provider/instances/{alias}', mock => mock.fixture('idp.get')],
  // Keycloak HEAD answers Accept */* with YAML here and only sends JSON when asked for it.
  ['GET /admin/realms/{realm}/workflows', (mock, request) =>
    mock.fixture(request.headers.accept?.includes('application/json') ? 'workflows.json' : 'workflows.default')],
  ['POST /admin/realms/{realm}/logout-all', mock => mock.fixture('logoutAll')],
  // Named creates answer with the name in Location (RoleContainerResource.java:174, IdentityProvidersResource.java:291).
  ['POST /admin/realms/{realm}/roles', (mock, request) => createdAt(mock, request, request.json().name)],
  ['POST /admin/realms/{realm}/clients/{id}/roles', (mock, request) => createdAt(mock, request, request.json().name)],
  ['GET /admin/realms/{realm}/roles/{role-name}', mock => mock.fixture('role.get')],
  ['GET /admin/realms/{realm}/clients/{id}/roles/{role-name}', mock => mock.fixture('clientRole.get')],
  ['POST /admin/realms/{realm}/identity-provider/instances', (mock, request) => createdAt(mock, request, request.json().alias)],
  // Authorization objects are created with the ID the body names, if any (RepresentationToModel.java:1758, :1809).
  ['POST /admin/realms/{realm}/clients/{id}/authz/resource-server/scope', (mock, request) =>
    ({ status: 201, json: { id: request.json().id ?? randomUUID(), name: request.json().name } })],
  ['POST /admin/realms/{realm}/clients/{id}/authz/resource-server/resource', (mock, request) =>
    ({ status: 201, json: { name: request.json().name, _id: request.json()._id ?? randomUUID() } })],
  ['POST /admin/realms', (mock, request) => ({ status: 201, headers: { location: mock.location(`/admin/realms/${request.json().realm}`) } })],
];

// Unprogrammed routes: reads miss like a JAX-RS 404, creates answer 201 with a Location, the rest 204.
function defaultResponse(mock, request) {
  if (request.method === 'GET') return mock.fixture('route.notFound');
  if (request.method === 'POST') return createdAt(mock, request, randomUUID());
  return { status: 204 };
}

export async function startMockKeycloak({ realm = 'test-realm', authRealm = 'master', clientId = 'mcp-service',
  clientSecret = 'mock-client-secret', expiresIn = recordedExpiresIn } = {}) {
  return new MockKeycloak({ realm, authRealm, clientId, clientSecret, expiresIn }).listen();
}
