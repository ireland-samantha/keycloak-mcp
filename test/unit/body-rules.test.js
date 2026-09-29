import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflight } from '../../src/api.js';
import { irreversibleBodyRules } from '../../src/policy/classify.js';
import { testConfig } from '../support/config.js';

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
const requiredAction = ['PUT /admin/realms/{realm}/authentication/required-actions/{alias}', { alias: 'TERMS_AND_CONDITIONS' }];
const clientPermissions = ['PUT /admin/realms/{realm}/clients/{client-uuid}/management/permissions', { 'client-uuid': 'c' }];
const groupCreate = ['POST /admin/realms/{realm}/groups', {}];
const authenticatorConfig = ['PUT /admin/realms/{realm}/authentication/config/{id}', { id: 'a' }];

// [operation and path, body, the rules it triggers]; a body that triggers none stays a reversible update.
const cases = [
  [user, { firstName: 'Ada', enabled: false }, []],
  [user, { credentials: [{ type: 'password', value: 'Chosen-1', temporary: false }] }, ['sets-credentials', 'sets-secret']],
  [user, { credentials: [{ type: 'password', temporary: true }] }, ['sets-credentials']],
  [client, { description: 'x', authorizationServicesEnabled: true }, []],
  [client, { authorizationServicesEnabled: true, secret: 'chosen-secret' }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, secret: mask }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, registrationAccessToken: 'token' }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'saml.signing.private.key': 'MIIE' } }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'custom.api.key': 'named-by-the-operator' } }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'jwks.string': JSON.stringify({ keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', d: 'private' }] }) } }, ['sets-secret']],
  [client, { authorizationServicesEnabled: true, attributes: { 'jwks.string': JSON.stringify({ keys: [{ kty: 'RSA', n: 'n', e: 'AQAB' }] }) } }, []],
  [realm, { displayName: 'Renamed display' }, []],
  [realm, { realm: 'test-realm', displayName: 'same name' }, []],
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
  [component, { config: { privateKey: ['-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'] } }, ['sets-secret']],
  [idp, { alias: 'broker', config: { clientSecret: mask, tokenUrl: 'https://idp.example.invalid/token' } }, ['repoints-idp-secret']],
  [idp, { alias: 'broker', config: { clientSecret: mask, tokenIntrospectionUrl: 'https://idp.example.invalid/introspect' } }, ['repoints-idp-secret']],
  [idp, { alias: 'broker', config: { clientSecret: mask, syncMode: 'IMPORT' } }, []],
  [idp, { alias: 'broker', config: { clientSecret: 'new-secret', tokenUrl: 'https://idp.example.invalid/token' } }, ['sets-secret']],
  [authenticatorConfig, { alias: 'captcha', config: { 'secret.key': mask } }, []],
  [authenticatorConfig, { alias: 'captcha', config: { 'secret.key': 'new-key' } }, ['sets-secret']],
  [role, { name: 'viewer', description: 'd' }, []],
  [requiredAction, { alias: 'TERMS_AND_CONDITIONS', enabled: true }, []],
  [clientPermissions, { enabled: true }, []],
  [groupCreate, { name: 'new' }, []],
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

test('a body sent as bodyBase64 is judged by the JSON it carries', () => {
  const bodyBase64 = Buffer.from(JSON.stringify({ credentials: [{ type: 'password', value: 'Chosen-1' }] })).toString('base64');
  assert.throws(() => preflight(writer, [{ operation: user[0], args: { path: user[1], bodyBase64 },
    compensate: { operation: user[0], args: { path: user[1], body: {} } } }]), /irreversible and requires an explicit override: .*\[sets-credentials\]/);
});

test('an update compensated by a body that is itself irreversible is refused', () => {
  assert.throws(() => preflight(writer, [{ operation: user[0], args: { path: user[1], body: { firstName: 'Ada' } },
    compensate: { operation: user[0], args: { path: user[1], body: { credentials: [{ type: 'password', value: 'Old-1' }] } } } }]),
  { message: 'step 1 cannot use an irreversible compensation without a generated-ID or matching created-name binding: [sets-credentials] the body sets credentials; [sets-secret] the body sets a secret' });
});
