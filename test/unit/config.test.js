import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromEnv } from '../../src/api.js';
import { testEnv } from '../support/config.js';
import { privateTempDir, writePrivateJson } from '../support/temp.js';

const switches = ['KEYCLOAK_MCP_ALLOW_WRITE', 'KEYCLOAK_MCP_ALLOW_REALM_ADMIN', 'KEYCLOAK_MCP_ALLOW_SENSITIVE_READS',
  'KEYCLOAK_MCP_ALLOW_IRREVERSIBLE', 'KEYCLOAK_MCP_SINGLE_WRITER'];
const configFile = settings => writePrivateJson(join(privateTempDir('keycloak-mcp-config-'), 'config.json'), settings);

test('a switch is on for JSON true or "true" and off for false, "false" or no value', () => {
  const on = configFromEnv({ KEYCLOAK_MCP_CONFIG: configFile({ ...testEnv, ...Object.fromEntries(switches.map(name => [name, true])) }) });
  assert.deepEqual([on.allowWrite, on.allowRealmAdmin, on.allowSensitiveReads, on.allowIrreversible, on.singleWriter], [true, true, true, true, true]);
  for (const value of ['true', true]) assert.equal(configFromEnv({ ...testEnv, KEYCLOAK_MCP_ALLOW_WRITE: value }).allowWrite, true);
  for (const value of ['false', false, '', undefined]) assert.equal(configFromEnv({ ...testEnv, KEYCLOAK_MCP_ALLOW_WRITE: value }).allowWrite, false);
});

test('any other switch value is a configuration error', () => {
  for (const value of ['yes', 'TRUE', 1, 'on']) {
    assert.throws(() => configFromEnv({ ...testEnv, KEYCLOAK_MCP_SINGLE_WRITER: value }), { message: 'KEYCLOAK_MCP_SINGLE_WRITER must be true or false' }, String(value));
  }
});

test('the private config file wins over the environment, which only fills in what the file leaves out', () => {
  const file = configFile({ ...testEnv, KEYCLOAK_MCP_LOCK_DATABASE_URL: 'postgres://locks.example.invalid/keycloak' });
  const config = configFromEnv({ KEYCLOAK_MCP_CONFIG: file, KEYCLOAK_REALM: 'other', KEYCLOAK_MCP_LOCK_DATABASE_URL: '', KEYCLOAK_MCP_JOURNAL_DIR: '/var/lib/receipts' });
  assert.equal(config.realm, testEnv.KEYCLOAK_REALM);
  assert.equal(config.lockDatabaseUrl, 'postgres://locks.example.invalid/keycloak');
  assert.equal(config.journalDir, '/var/lib/receipts');
});

test('an empty environment value counts as unset', () => {
  const config = configFromEnv({ ...testEnv, KEYCLOAK_AUTH_REALM: '', KEYCLOAK_MCP_CATALOG_VERSION: '', KEYCLOAK_MCP_MAX_BODY_BYTES: '' });
  assert.deepEqual([config.authRealm, config.catalogVersion, config.maxBodyBytes], ['master', 'latest', 1024 * 1024]);
  assert.equal(configFromEnv({ ...testEnv, KEYCLOAK_MCP_CONFIG: '' }).realm, testEnv.KEYCLOAK_REALM);
});

test('a realm named "." or ".." is refused, since it would act as a dot segment in every URL', () => {
  for (const label of ['KEYCLOAK_REALM', 'KEYCLOAK_AUTH_REALM']) for (const name of ['.', '..']) {
    assert.throws(() => configFromEnv({ ...testEnv, [label]: name }), { message: `${label} cannot be '.' or '..'` }, `${label}=${name}`);
  }
  assert.equal(configFromEnv({ ...testEnv, KEYCLOAK_REALM: '...' }).realm, '...');
});

test('KEYCLOAK_MCP_SECRET_ATTRIBUTES is a comma-separated list, or a list in the JSON config', () => {
  assert.deepEqual(configFromEnv(testEnv).secretAttributes, []);
  assert.deepEqual(configFromEnv({ ...testEnv, KEYCLOAK_MCP_SECRET_ATTRIBUTES: 'customApiKey, custom.api.key' }).secretAttributes, ['customApiKey', 'custom.api.key']);
  assert.deepEqual(configFromEnv({ KEYCLOAK_MCP_CONFIG: configFile({ ...testEnv, KEYCLOAK_MCP_SECRET_ATTRIBUTES: ['a.key'] }) }).secretAttributes, ['a.key']);
  for (const value of ['a,,b', [''], [3], 5]) {
    assert.throws(() => configFromEnv({ ...testEnv, KEYCLOAK_MCP_SECRET_ATTRIBUTES: value }), { message: 'KEYCLOAK_MCP_SECRET_ATTRIBUTES must list non-empty names' }, JSON.stringify(value));
  }
});
