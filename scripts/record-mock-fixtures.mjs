// Records Admin REST responses from a disposable Keycloak as default bodies for the mock tier
// (test/mock/fixtures/keycloak-head.json). It creates, fills and finally deletes one realm.
//
//   KEYCLOAK_URL=http://127.0.0.1:18080 KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=... \
//   KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:nightly KEYCLOAK_IMAGE_DIGEST=sha256:... \
//   node scripts/record-mock-fixtures.mjs
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const origin = new URL(process.env.KEYCLOAK_URL ?? 'http://127.0.0.1:18080').origin;
const { KEYCLOAK_ADMIN: adminUser, KEYCLOAK_ADMIN_PASSWORD: adminPassword } = process.env;
if (!adminUser || !adminPassword) throw new Error('KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD are required');
const realm = 'n1-mock-fixtures';
const output = new URL('../test/mock/fixtures/keycloak-head.json', import.meta.url);
// Values this script sets itself; none may survive scrubbing. Keycloak returns some of them in clear and
// masks others, so the scrubbed placeholders mark where secrets sit in real representations.
const planted = {
  clientSecret: 'fixture-client-secret-7d1e', smtpPassword: 'fixture-smtp-password-7d1e',
  idpSecret: 'fixture-idp-secret-7d1e', userPassword: 'Fixture-User-Password-7d1e',
  rotatedSecret: 'fixture-rotated-secret-7d1e', samlPrivateKey: 'fixture-saml-private-key-7d1e', jwkPrivate: 'fixture-jwk-private-7d1e',
  pemPrivateKey: 'fixture-pem-private-key-7d1e', ldapBindCredential: 'fixture-ldap-bind-7d1e',
  realmAttribute: 'fixture-realm-attribute-7d1e', clientAttribute: 'fixture-client-attribute-7d1e',
  keystorePassword: 'fixture-keystore-password-7d1e',
};
// Secrets Keycloak generates and returns in clear; scrubbed like the planted ones.
const generated = [];
// A real key, because Keycloak parses an imported one; it masks it in every response.
const importedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const jwks = JSON.stringify({ keys: [
  { kty: 'RSA', kid: 'fixture-rsa', use: 'sig', alg: 'RS256', n: 'fixture-public-modulus', e: 'AQAB',
    d: planted.jwkPrivate, p: planted.jwkPrivate, q: planted.jwkPrivate, dp: planted.jwkPrivate, dq: planted.jwkPrivate, qi: planted.jwkPrivate },
  { kty: 'oct', kid: 'fixture-oct', k: planted.jwkPrivate },
] });
const jwt = /eyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const admin = `${origin}/admin/realms/${realm}`;
const responses = {};
let adminToken;

async function call(method, url, { json, form, headers = {}, token = adminToken } = {}) {
  const response = await fetch(url, {
    method, redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json === undefined ? form : JSON.stringify(json),
  });
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    headers: Object.fromEntries(['content-type', 'location'].filter(name => response.headers.has(name)).map(name => [name, response.headers.get(name)])),
    body: text && type.includes('json') ? JSON.parse(text) : text || null,
  };
}

// A PKCS12 keystore holding a key pair that Keycloak generates for the client.
async function generatedKeystore(clientId) {
  const response = await fetch(`${admin}/clients/${clientId}/certificates/jwt.credential/generate-and-download`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'PKCS12', keyAlias: 'fixture-key', keyPassword: planted.keystorePassword, storePassword: planted.keystorePassword, realmCertificate: false }),
  });
  if (!response.ok) throw new Error(`keystore generation failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function record(name, operation, method, path, options) {
  const response = await call(method, path.startsWith('http') ? path : `${admin}${path}`, options);
  responses[name] = { operation, ...response };
  return response;
}

const createdId = response => response.headers.location.split('/').at(-1);

function scrub(value) {
  if (typeof value === 'string') {
    let text = value.replace(jwt, '<scrubbed-jwt>');
    for (const secret of [...Object.values(planted), ...generated]) text = text.replaceAll(secret, '<scrubbed-secret>');
    return text.replaceAll(origin, '{origin}').replaceAll(realm, '{realm}');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrub(child)]));
  return value;
}

async function recordAll() {
  await record('realm.create', 'POST /admin/realms', 'POST', `${origin}/admin/realms`, { json: {
    realm, enabled: true, adminEventsEnabled: true, adminEventsDetailsEnabled: true,
    smtpServer: { host: 'smtp.example.invalid', port: '25', from: 'noreply@example.invalid', auth: 'true', user: 'mailer', password: planted.smtpPassword },
    attributes: { customApiKey: planted.realmAttribute },
  } });
  await record('realm.get', 'GET /admin/realms/{realm}', 'GET', '');
  await record('realm.update', 'PUT /admin/realms/{realm}', 'PUT', '', { json: { displayName: 'Mock fixtures' } });

  const client = await record('clients.create', 'POST /admin/realms/{realm}/clients', 'POST', '/clients', { json: {
    clientId: 'fixture-service', publicClient: false, secret: planted.clientSecret, serviceAccountsEnabled: true,
    authorizationServicesEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
    attributes: {
      'client.secret.rotated': planted.rotatedSecret, 'saml.signing.private.key': planted.samlPrivateKey, 'jwks.string': jwks,
      'custom.api.key': planted.clientAttribute, 'custom.tls.key': `-----BEGIN PRIVATE KEY-----\n${planted.pemPrivateKey}\n-----END PRIVATE KEY-----\n`,
      'access.token.lifespan': '120', 'use.refresh.tokens': 'true', 'client_credentials.use_refresh_token': 'false',
    },
  } });
  const clientId = createdId(client);
  await record('client.registrationAccessToken', 'POST /admin/realms/{realm}/clients/{client-uuid}/registration-access-token', 'POST',
    `/clients/${clientId}/registration-access-token`);
  await record('clients.list', 'GET /admin/realms/{realm}/clients', 'GET', '/clients?clientId=fixture-service');
  await record('client.get', 'GET /admin/realms/{realm}/clients/{client-uuid}', 'GET', `/clients/${clientId}`);
  await record('client.secret', 'GET /admin/realms/{realm}/clients/{client-uuid}/client-secret', 'GET', `/clients/${clientId}/client-secret`);
  await record('client.installation.json', 'GET /admin/realms/{realm}/clients/{client-uuid}/installation/providers/{providerId}', 'GET',
    `/clients/${clientId}/installation/providers/keycloak-oidc-keycloak-json`);
  await record('client.installation.xml', 'GET /admin/realms/{realm}/clients/{client-uuid}/installation/providers/{providerId}', 'GET',
    `/clients/${clientId}/installation/providers/keycloak-oidc-jboss-subsystem`);
  await record('client.certificate', 'GET /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}', 'GET',
    `/clients/${clientId}/certificates/jwt.credential`);

  const tokenUrl = `${origin}/realms/${realm}/protocol/openid-connect/token`;
  const basic = secret => `Basic ${Buffer.from(`fixture-service:${secret}`).toString('base64')}`;
  const grant = () => new URLSearchParams({ grant_type: 'client_credentials' });
  await record('token.ok', 'POST /realms/{realm}/protocol/openid-connect/token', 'POST', tokenUrl,
    { form: grant(), headers: { authorization: basic(planted.clientSecret) }, token: null });
  await record('token.invalidClient', 'POST /realms/{realm}/protocol/openid-connect/token', 'POST', tokenUrl,
    { form: grant(), headers: { authorization: basic('wrong-secret') }, token: null });
  await record('admin.unauthorized', 'GET /admin/realms/{realm}', 'GET', '', { token: 'not-a-token' });
  await record('route.notFound', 'GET /admin/realms/{realm}/no-such-route', 'GET', '/no-such-route');

  const user = await record('users.create', 'POST /admin/realms/{realm}/users', 'POST', '/users',
    { json: { username: 'fixture-user', enabled: true, email: 'fixture-user@example.invalid', firstName: 'Fixture', lastName: 'User' } });
  const userId = createdId(user);
  await call('PUT', `${admin}/users/${userId}/reset-password`, { json: { type: 'password', value: planted.userPassword, temporary: false } });
  await record('users.list', 'GET /admin/realms/{realm}/users', 'GET', '/users?briefRepresentation=true');
  await record('users.count', 'GET /admin/realms/{realm}/users/count', 'GET', '/users/count');
  await record('user.get', 'GET /admin/realms/{realm}/users/{user-id}', 'GET', `/users/${userId}`);
  await record('user.notFound', 'GET /admin/realms/{realm}/users/{user-id}', 'GET', '/users/00000000-0000-4000-8000-000000000000');
  await record('user.credentials', 'GET /admin/realms/{realm}/users/{user-id}/credentials', 'GET', `/users/${userId}/credentials`);
  await record('example.accessToken', 'GET /admin/realms/{realm}/clients/{client-uuid}/evaluate-scopes/generate-example-access-token', 'GET',
    `/clients/${clientId}/evaluate-scopes/generate-example-access-token?userId=${userId}`);

  const group = await record('groups.create', 'POST /admin/realms/{realm}/groups', 'POST', '/groups', { json: { name: 'fixture-group' } });
  await record('groups.conflict', 'POST /admin/realms/{realm}/groups', 'POST', '/groups', { json: { name: 'fixture-group' } });
  await record('groups.list', 'GET /admin/realms/{realm}/groups', 'GET', '/groups');
  await record('roles.create', 'POST /admin/realms/{realm}/roles', 'POST', '/roles', { json: { name: 'fixture-role' } });
  await record('role.get', 'GET /admin/realms/{realm}/roles/{role-name}', 'GET', '/roles/fixture-role');
  await record('clientRoles.create', 'POST /admin/realms/{realm}/clients/{client-uuid}/roles', 'POST', `/clients/${clientId}/roles`, { json: { name: 'fixture-client-role' } });
  await record('clientRole.get', 'GET /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}', 'GET', `/clients/${clientId}/roles/fixture-client-role`);
  await record('idp.create', 'POST /admin/realms/{realm}/identity-provider/instances', 'POST', '/identity-provider/instances', { json: {
    alias: 'fixture-idp', providerId: 'oidc', enabled: false, config: {
      clientId: 'fixture-broker', clientSecret: planted.idpSecret, clientAuthMethod: 'client_secret_post',
      authorizationUrl: 'https://idp.example.invalid/auth', tokenUrl: 'https://idp.example.invalid/token',
    },
  } });
  await record('idp.get', 'GET /admin/realms/{realm}/identity-provider/instances/{alias}', 'GET', '/identity-provider/instances/fixture-idp');
  // The alias of an identity provider cannot be changed (IdentityProviderResource.java:203-205).
  await record('idp.renameRefused', 'PUT /admin/realms/{realm}/identity-provider/instances/{alias}', 'PUT', '/identity-provider/instances/fixture-idp',
    { json: { alias: 'fixture-idp-renamed', providerId: 'oidc' } });
  // The converter returns the private key of an uploaded keystore in clear (CertificateInfoHelper.java:303-305).
  const keystore = new FormData();
  for (const [name, value] of Object.entries({ keystoreFormat: 'PKCS12', keyAlias: 'fixture-key', keyPassword: planted.keystorePassword, storePassword: planted.keystorePassword }))
    keystore.append(name, value);
  keystore.append('file', new Blob([await generatedKeystore(clientId)], { type: 'application/x-pkcs12' }), 'fixture.p12');
  const uploaded = await record('idp.uploadCertificate', 'POST /admin/realms/{realm}/identity-provider/upload-certificate', 'POST',
    '/identity-provider/upload-certificate', { form: keystore });
  if (typeof uploaded.body?.privateKey === 'string') generated.push(uploaded.body.privateKey);

  const realmId = (await call('GET', admin)).body.id;
  await call('POST', `${admin}/components`, { json: { name: 'fixture-ldap', providerId: 'ldap', providerType: 'org.keycloak.storage.UserStorageProvider', parentId: realmId,
    config: { vendor: ['other'], connectionUrl: ['ldap://ldap.example.invalid'], bindDn: ['cn=admin,dc=example,dc=invalid'], bindCredential: [planted.ldapBindCredential],
      usersDn: ['ou=users,dc=example,dc=invalid'], usernameLDAPAttribute: ['uid'], rdnLDAPAttribute: ['uid'], uuidLDAPAttribute: ['entryUUID'],
      userObjectClasses: ['inetOrgPerson'], editMode: ['READ_ONLY'], authType: ['simple'], enabled: ['false'], usePasswordModifyExtendedOp: ['false'], validatePasswordPolicy: ['false'] } } });
  await call('POST', `${admin}/components`, { json: { name: 'fixture-imported-rsa', providerId: 'rsa', providerType: 'org.keycloak.keys.KeyProvider', parentId: realmId,
    config: { priority: ['5'], privateKey: [importedKey] } } });
  await record('components.list', 'GET /admin/realms/{realm}/components', 'GET', '/components');

  const authz = `/clients/${clientId}/authz/resource-server`;
  await record('authz.scope.create', 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope', 'POST',
    `${authz}/scope`, { json: { name: 'fixture-scope' } });
  // ScopeService.create looks the scope up by name and returns the existing one (WF-01).
  await record('authz.scope.createExisting', 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope', 'POST',
    `${authz}/scope`, { json: { name: 'fixture-scope' } });
  await record('authz.resource.create', 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource', 'POST',
    `${authz}/resource`, { json: { name: 'fixture-resource' } });
  // With an ID nothing has yet, both creates are strict: Keycloak creates exactly that ID or refuses the
  // taken name (RepresentationToModel.java:1719-1758, :1794-1809) (WF-01).
  await record('authz.scope.createWithId', 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope', 'POST',
    `${authz}/scope`, { json: { id: randomUUID(), name: 'fixture-scope-with-id' } });
  await record('authz.scope.createWithIdExisting', 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope', 'POST',
    `${authz}/scope`, { json: { id: randomUUID(), name: 'fixture-scope' } });
  await record('authz.resource.createWithIdExisting', 'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource', 'POST',
    `${authz}/resource`, { json: { _id: randomUUID(), name: 'fixture-resource' } });

  await record('initialAccess.create', 'POST /admin/realms/{realm}/clients-initial-access', 'POST', '/clients-initial-access', { json: { expiration: 60, count: 1 } });
  await record('initialAccess.list', 'GET /admin/realms/{realm}/clients-initial-access', 'GET', '/clients-initial-access');
  await record('workflows.default', 'GET /admin/realms/{realm}/workflows', 'GET', '/workflows');
  await record('workflows.json', 'GET /admin/realms/{realm}/workflows', 'GET', '/workflows', { headers: { accept: 'application/json' } });
  await record('events.config', 'GET /admin/realms/{realm}/events/config', 'GET', '/events/config');
  await record('groups.delete', 'DELETE /admin/realms/{realm}/groups/{group-id}', 'DELETE', `/groups/${createdId(group)}`);
  await record('adminEvents.list', 'GET /admin/realms/{realm}/admin-events', 'GET', '/admin-events?max=3');
  await record('logoutAll', 'POST /admin/realms/{realm}/logout-all', 'POST', '/logout-all');
}

async function serverVersion() {
  return (await call('GET', `${origin}/admin/serverinfo`)).body.systemInfo.version;
}

const login = await call('POST', `${origin}/realms/master/protocol/openid-connect/token`, { token: null,
  form: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }) });
adminToken = login.body.access_token;
// A realm left behind by an interrupted run of this script is removed first.
await call('DELETE', `${origin}/admin/realms/${realm}`);
try {
  await recordAll();
  const version = await serverVersion();
  const fixtures = scrub({
    provenance: {
      image: process.env.KEYCLOAK_IMAGE ?? null, imageDigest: process.env.KEYCLOAK_IMAGE_DIGEST ?? null, serverVersion: version,
      recordedAt: new Date().toISOString().slice(0, 10), recorder: 'scripts/record-mock-fixtures.mjs',
      placeholders: '{origin} and {realm} stand for the server origin and realm; <scrubbed-jwt> and <scrubbed-secret> replace tokens and planted secrets',
    },
    responses,
  });
  const text = `${JSON.stringify(fixtures, null, 1)}\n`;
  if (text.search(jwt) !== -1 || [...Object.values(planted), ...generated, importedKey].some(secret => text.includes(secret))) throw new Error('a secret survived scrubbing');
  writeFileSync(output, text);
  console.log(JSON.stringify({ serverVersion: version, responses: Object.keys(responses).length }));
} finally {
  await call('DELETE', `${origin}/admin/realms/${realm}`);
}
