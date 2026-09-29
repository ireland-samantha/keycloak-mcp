import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflight } from '../../src/api.js';
import { irreversibleBodyRules } from '../../src/policy/classify.js';
import { testConfig } from '../support/config.js';
import { base64, utf16be, utf32, withMark } from '../support/encodings.js';

const writer = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_SECRET_ATTRIBUTES: 'custom.api.key' });
const override = testConfig({ KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true', KEYCLOAK_MCP_ALLOW_IRREVERSIBLE: 'true' });
const mask = '**********';

const user = ['PUT /admin/realms/{realm}/users/{user-id}', { 'user-id': 'u' }];
const client = ['PUT /admin/realms/{realm}/clients/{client-uuid}', { 'client-uuid': 'c' }];
const realm = ['PUT /admin/realms/{realm}', {}];
const events = ['PUT /admin/realms/{realm}/events/config', {}];
const component = ['PUT /admin/realms/{realm}/components/{id}', { id: 'k' }];
const idp = ['PUT /admin/realms/{realm}/identity-provider/instances/{alias}', { alias: 'broker' }];
const role = ['PUT /admin/realms/{realm}/roles/{role-name}', { 'role-name': 'viewer' }];
const clientRole = ['PUT /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}', { 'client-uuid': 'c', 'role-name': 'viewer' }];
const requiredAction = ['PUT /admin/realms/{realm}/authentication/required-actions/{alias}', { alias: 'TERMS_AND_CONDITIONS' }];
const clientPermissions = ['PUT /admin/realms/{realm}/clients/{client-uuid}/management/permissions', { 'client-uuid': 'c' }];
const usersPermissions = ['PUT /admin/realms/{realm}/users-management-permissions', {}];
const groupCreate = ['POST /admin/realms/{realm}/groups', {}];
const childCreate = ['POST /admin/realms/{realm}/groups/{group-id}/children', { 'group-id': 'parent' }];
const authenticatorConfig = ['PUT /admin/realms/{realm}/authentication/config/{id}', { id: 'a' }];

// [operation and path, body, the rules it triggers]; a body that triggers none stays a reversible update.
const cases = [
  [user, { firstName: 'Ada', enabled: false }, []],
  [user, { credentials: [{ type: 'password', value: 'Chosen-1', temporary: false }] }, ['sets-credentials', 'sets-secret']],
  [user, { credentials: [{ type: 'password', temporary: true }] }, ['sets-credentials']],
  [user, { federationLink: 'ldap-provider-id' }, ['links-federation']],
  [user, { enabled: true }, ['unlocks-user']],
  [client, { description: 'x', authorizationServicesEnabled: true }, []],
  [client, { description: 'x' }, ['drops-authorization']],
  [client, { authorizationServicesEnabled: true, publicClient: true }, ['drops-authorization']],
  [client, { authorizationServicesEnabled: true, serviceAccountsEnabled: false }, ['disables-service-account']],
  [client, { authorizationServicesEnabled: true, secret: 'chosen-secret' }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, secret: mask }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, registrationAccessToken: 'token' }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'saml.signing.private.key': 'MIIE' } }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'custom.api.key': 'named-by-the-operator' } }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'jwks.string': JSON.stringify({ keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', d: 'private' }] }) } }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'jwks.string': JSON.stringify({ keys: [{ kty: 'RSA', n: 'n', e: 'AQAB' }] }) } }, []],
  [realm, { displayName: 'Renamed display' }, []],
  [realm, { realm: 'test-realm', displayName: 'same name' }, []],
  [realm, { realm: 'other-realm' }, ['renames-realm']],
  [realm, { notBefore: 1790000000 }, ['moves-not-before']],
  [realm, { smtpServer: { host: 'smtp.example.invalid', password: mask } }, ['replaces-smtp']],
  [realm, { adminEventsEnabled: false }, ['stops-realm-events']],
  [realm, { eventsListeners: ['jboss-logging'] }, ['stops-realm-events']],
  [realm, { eventsExpiration: JSON.rawJSON('9007199254740993') }, ['stops-realm-events']],
  [realm, { eventsEnabled: true, adminEventsEnabled: true, eventsExpiration: 0 }, []],
  [events, { eventsEnabled: true, adminEventsEnabled: true, adminEventsDetailsEnabled: true }, []],
  [events, { adminEventsEnabled: true }, ['stops-events']],
  [events, { eventsEnabled: true, adminEventsEnabled: false }, ['stops-events']],
  [events, { eventsEnabled: true, enabledEventTypes: ['LOGIN'] }, ['stops-events']],
  [events, { eventsEnabled: true, eventsExpiration: 3600 }, ['stops-events']],
  [component, { config: { priority: ['10'], bindCredential: [mask] } }, []],
  [component, { config: { bindCredential: ['new-password'] } }, ['sets-secret']],
  [component, { config: { bindCredential: [] } }, ['sets-secret']],
  [component, { config: { connectionUrl: ['ldap://directory.example.invalid'] } }, ['repoints-federation']],
  [component, { config: { bindDn: ['cn=other'] } }, ['repoints-federation']],
  [component, { config: { scimurl: ['https://ipatuura.example.invalid'] } }, ['repoints-federation']],
  [component, { config: { keySize: ['4096'] } }, ['regenerates-keys']],
  [component, { config: { ecdsaEllipticCurveKey: ['P-384'] } }, ['regenerates-keys']],
  [component, { config: { privateKey: ['-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'] } }, ['sets-secret']],
  [idp, { alias: 'broker', config: { clientSecret: mask, tokenUrl: 'https://idp.example.invalid/token' } }, ['repoints-idp-secret']],
  [idp, { alias: 'broker', config: { clientSecret: mask, tokenIntrospectionUrl: 'https://idp.example.invalid/introspect' } }, ['repoints-idp-secret']],
  [idp, { alias: 'broker', config: { clientSecret: mask, syncMode: 'IMPORT' } }, []],
  [idp, { alias: 'broker', config: { clientSecret: 'new-secret', tokenUrl: 'https://idp.example.invalid/token' } }, ['sets-secret']],
  [authenticatorConfig, { alias: 'captcha', config: { 'secret.key': mask } }, []],
  [authenticatorConfig, { alias: 'captcha', config: { 'secret.key': 'new-key' } }, ['sets-secret']],
  [role, { name: 'viewer', description: 'd' }, []],
  [role, { name: 'viewer-renamed' }, ['renames-role']],
  [clientRole, { name: 'other' }, ['renames-role']],
  [requiredAction, { alias: 'TERMS_AND_CONDITIONS', enabled: true }, []],
  [requiredAction, { alias: 'OTHER' }, ['renames-required-action']],
  [requiredAction, { enabled: true }, ['renames-required-action']],
  [clientPermissions, { enabled: true }, []],
  [clientPermissions, { enabled: false }, ['disables-admin-permissions']],
  [usersPermissions, {}, ['disables-admin-permissions']],
  [groupCreate, { name: 'new' }, []],
  [groupCreate, { name: 'moved', id: 'existing-group' }, ['moves-group']],
  [childCreate, { name: 'moved', id: 'existing-group' }, ['moves-group']],
  // Keycloak's Jackson reads true/True/TRUE and false/False/FALSE, trimmed, a non-zero integer as true
  // and 0 as false, and "", blank and "null" as no value; kc-head applied each such value to adminEventsEnabled.
  // A value it refuses counts as the state a rule guards against.
  [user, { enabled: 'true' }, ['unlocks-user']],
  [user, { enabled: ' TRUE ' }, ['unlocks-user']],
  [user, { enabled: 1 }, ['unlocks-user']],
  [user, { enabled: 'yes' }, ['unlocks-user']],
  [user, { enabled: 'false' }, []],
  [user, { enabled: 0 }, []],
  [user, { enabled: '' }, []],
  [user, { enabled: 'null' }, []],
  [client, { authorizationServicesEnabled: 'true', serviceAccountsEnabled: 'True' }, []],
  [client, { authorizationServicesEnabled: 1, publicClient: 'false', bearerOnly: 0 }, []],
  [client, { authorizationServicesEnabled: true, serviceAccountsEnabled: 'false' }, ['disables-service-account']],
  [client, { authorizationServicesEnabled: true, serviceAccountsEnabled: '\tFALSE\n' }, ['disables-service-account']],
  [client, { authorizationServicesEnabled: true, serviceAccountsEnabled: 0 }, ['disables-service-account']],
  [client, { authorizationServicesEnabled: true, serviceAccountsEnabled: JSON.rawJSON('-0') }, ['disables-service-account']],
  [client, { authorizationServicesEnabled: true, serviceAccountsEnabled: 0.5 }, ['disables-service-account']],
  [client, { authorizationServicesEnabled: 'false' }, ['drops-authorization']],
  [client, { authorizationServicesEnabled: 'on' }, ['drops-authorization']],
  [client, { authorizationServicesEnabled: true, bearerOnly: 'true' }, ['drops-authorization']],
  [client, { authorizationServicesEnabled: true, publicClient: JSON.rawJSON('12345678901234567890') }, ['drops-authorization']],
  [realm, { eventsEnabled: 'TRUE', adminEventsEnabled: 1, adminEventsDetailsEnabled: 'true', eventsExpiration: '0' }, []],
  [realm, { eventsEnabled: '', adminEventsEnabled: 'null' }, []],
  [realm, { adminEventsEnabled: 'false' }, ['stops-realm-events']],
  [realm, { adminEventsDetailsEnabled: 0 }, ['stops-realm-events']],
  [realm, { eventsEnabled: 'False' }, ['stops-realm-events']],
  [realm, { eventsExpiration: '3600' }, ['stops-realm-events']],
  [events, { eventsEnabled: 'true', adminEventsEnabled: 'TRUE', adminEventsDetailsEnabled: 1, eventsExpiration: '-5' }, []],
  [events, { eventsEnabled: true, adminEventsEnabled: 'false' }, ['stops-events']],
  [events, { eventsEnabled: 0, adminEventsEnabled: true }, ['stops-events']],
  [events, { eventsEnabled: 'null', adminEventsEnabled: true }, ['stops-events']],
  [events, { eventsEnabled: true, eventsExpiration: '٣٦٠٠' }, ['stops-events']],
  [clientPermissions, { enabled: 'TRUE' }, []],
  [clientPermissions, { enabled: 'false' }, ['disables-admin-permissions']],
  [clientPermissions, { enabled: 'yes' }, ['disables-admin-permissions']],
];

// A step whose compensation is itself: the rules decide whether preflight accepts it without the override.
const selfCompensated = ([operation, path], body) => ({ operation, args: { path, body }, compensate: { operation, args: { path, body } } });

for (const [[operation, path], body, rules] of cases) {
  test(`${operation} with ${JSON.stringify(body)} ${rules.length ? `is irreversible: ${rules.join(', ')}` : 'stays reversible'}`, () => {
    assert.deepEqual(irreversibleBodyRules(operation, { path, body }, writer).map(rule => rule.name), rules);
    if (!rules.length) return;
    assert.throws(() => preflight(writer, [selfCompensated([operation, path], body)]),
      error => error.message.startsWith('step 1 is irreversible and requires an explicit override: ') && rules.every(rule => error.message.includes(`[${rule}]`)));
    assert.equal(preflight(override, [{ operation, args: { path, body }, irreversible: true }])[0].irreversible, true);
  });
}

test('a reversible update body passes preflight with a same-route compensation', () => {
  assert.equal(preflight(writer, [selfCompensated(user, { firstName: 'Ada' })])[0].irreversible, false);
});

const password = JSON.stringify({ credentials: [{ type: 'password', value: 'Chosen-1', temporary: false }] });
const irreversibleCompensation = 'step 1 cannot use an irreversible compensation without a generated-ID or matching created-name binding: ';
const passwordRules = '[sets-credentials] the body sets credentials; [sets-secret] the body sets a secret';
const unreadableRule = '[unreadable-body] the body is not JSON that keycloak-mcp can read the way Keycloak does';

// A step sending `bodyBase64` as a user update, compensated by a harmless update of the same user.
const base64Step = (bodyBase64, compensate = { operation: user[0], args: { path: user[1], body: { firstName: 'Ada' } } }) =>
  ({ operation: user[0], args: { path: user[1], bodyBase64 }, compensate });

// Keycloak reads a password body in each of these encodings, and HEAD set the password for the byte-order
// mark and UTF-16LE forms, so each triggers the same rules as the plain body.
const encodedPasswords = {
  'UTF-8': Buffer.from(password),
  'UTF-8 with a byte-order mark': withMark([0xef, 0xbb, 0xbf], Buffer.from(password)),
  'UTF-16LE': Buffer.from(password, 'utf16le'),
  'UTF-16BE with a byte-order mark': withMark([0xfe, 0xff], utf16be(password)),
  'UTF-32LE': utf32(password, 'LE'),
};

for (const [name, bytes] of Object.entries(encodedPasswords)) {
  test(`a password sent as bodyBase64 in ${name} is judged by the JSON Keycloak reads`, () => {
    assert.deepEqual(irreversibleBodyRules(user[0], { path: user[1], bodyBase64: base64(bytes) }, writer).map(rule => rule.name), ['sets-credentials', 'sets-secret']);
    assert.throws(() => preflight(writer, [base64Step(base64(bytes))]), { message: `step 1 is irreversible and requires an explicit override: ${passwordRules}` });
  });
}

// JSON bodies Jackson may read in a way a strict reader cannot follow; any of them could set a password.
const unreadablePasswords = {
  'an overlong UTF-8 key': Buffer.concat([Buffer.from('{"'), Buffer.from([0xc1, 0xa3]), Buffer.from(password.slice(3))]),
  'text after the document': Buffer.from(`${password} trailing`),
  'no JSON at all': Buffer.from('credentials=Chosen-1'),
};

for (const [name, bytes] of Object.entries(unreadablePasswords)) {
  test(`a JSON body with ${name} fails closed as unreadable-body`, () => {
    assert.deepEqual(irreversibleBodyRules(user[0], { path: user[1], bodyBase64: base64(bytes) }, writer).map(rule => rule.name), ['unreadable-body']);
    assert.throws(() => preflight(writer, [base64Step(base64(bytes))]), { message: `step 1 is irreversible and requires an explicit override: ${unreadableRule}` });
    assert.equal(preflight(override, [{ ...base64Step(base64(bytes)), irreversible: true }])[0].irreversible, true);
  });
}

test('a UTF-16 body that sets nothing hazardous stays reversible', () => {
  assert.equal(preflight(writer, [base64Step(base64(Buffer.from('{"firstName":"Ada"}', 'utf16le')))])[0].irreversible, false);
});

test('a text body sent as bodyBase64 is not judged as JSON', () => {
  const label = ['PUT /admin/realms/{realm}/users/{user-id}/credentials/{credentialId}/userLabel', { 'user-id': 'u', credentialId: 'c' }];
  const args = { path: label[1], bodyBase64: base64(Buffer.from('laptop key')) };
  assert.deepEqual(irreversibleBodyRules(label[0], args, writer), []);
  assert.equal(preflight(writer, [{ operation: label[0], args, compensate: { operation: label[0], args: { path: label[1], body: 'old label' } } }])[0].irreversible, false);
});

test('an update compensated by a body that is itself irreversible is refused', () => {
  assert.throws(() => preflight(writer, [{ operation: user[0], args: { path: user[1], body: { firstName: 'Ada' } },
    compensate: { operation: user[0], args: { path: user[1], body: { credentials: [{ type: 'password', value: 'Old-1' }] } } } }]),
  { message: `${irreversibleCompensation}${passwordRules}` });
});

test('a compensation body is read as Keycloak reads it, and refused when it cannot be', () => {
  const compensate = bytes => base64Step(base64(Buffer.from('{"firstName":"Ada"}')), { operation: user[0], args: { path: user[1], bodyBase64: base64(bytes) } });
  assert.throws(() => preflight(writer, [compensate(Buffer.from(password, 'utf16le'))]), { message: `${irreversibleCompensation}${passwordRules}` });
  assert.throws(() => preflight(writer, [compensate(unreadablePasswords['an overlong UTF-8 key'])]), { message: `${irreversibleCompensation}${unreadableRule}` });
});
