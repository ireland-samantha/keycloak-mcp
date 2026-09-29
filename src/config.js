import { readPrivateJson } from './internal/private-file.js';

export const DEFAULT_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const REALM_NAME = /^[A-Za-z0-9._~-]{1,255}$/;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function bodyLimit(value) {
  if (value === undefined || value === '') return DEFAULT_BODY_BYTES;
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error('KEYCLOAK_MCP_MAX_BODY_BYTES must be a positive integer');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_BODY_BYTES) throw new Error('KEYCLOAK_MCP_MAX_BODY_BYTES exceeds 64 MiB');
  return bytes;
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function baseUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('KEYCLOAK_BASE_URL must not contain credentials, query, or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))) throw new Error('KEYCLOAK_BASE_URL must use HTTPS or loopback HTTP');
  return url.href.replace(/\/$/, '');
}

// '.' and '..' pass the character check but are dot segments: the token URL /realms/../protocol/...
// would resolve to /protocol/....
function realm(name, label) {
  if (!REALM_NAME.test(name)) throw new Error(`${label} has invalid characters`);
  if (name === '.' || name === '..') throw new Error(`${label} cannot be '.' or '..'`);
  return name;
}

// A switch is on for JSON true or the string 'true'; any other value than those or false is a mistake.
function flag(values, name) {
  const value = values[name];
  if (value === true || value === 'true') return true;
  if (value === undefined || value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

// Empty environment values count as unset. A KEYCLOAK_MCP_CONFIG file is authoritative for every
// setting it defines, so an ambient variable cannot retarget the realm or drop the lock; the
// environment only supplies the settings the file leaves out.
function settings(env) {
  const fromEnv = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  if (!fromEnv.KEYCLOAK_MCP_CONFIG) return fromEnv;
  const file = readPrivateJson(fromEnv.KEYCLOAK_MCP_CONFIG, 'KEYCLOAK_MCP_CONFIG');
  if (!file || Array.isArray(file) || typeof file !== 'object') throw new Error('KEYCLOAK_MCP_CONFIG must be a JSON object');
  return { ...fromEnv, ...file };
}

// A comma-separated list, or in the JSON config a list, of non-empty names.
function nameList(values, name) {
  const value = values[name];
  if (value === undefined) return [];
  const names = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(item => item.trim()) : null;
  if (!names || names.some(item => typeof item !== 'string' || !item)) throw new Error(`${name} must list non-empty names`);
  return names;
}

export function configFromEnv(env = process.env) {
  const values = settings(env);
  return {
    baseUrl: baseUrl(required('KEYCLOAK_BASE_URL', values.KEYCLOAK_BASE_URL)),
    realm: realm(required('KEYCLOAK_REALM', values.KEYCLOAK_REALM), 'KEYCLOAK_REALM'),
    authRealm: realm(values.KEYCLOAK_AUTH_REALM || 'master', 'KEYCLOAK_AUTH_REALM'),
    clientId: required('KEYCLOAK_CLIENT_ID', values.KEYCLOAK_CLIENT_ID),
    clientSecret: required('KEYCLOAK_CLIENT_SECRET', values.KEYCLOAK_CLIENT_SECRET),
    allowWrite: flag(values, 'KEYCLOAK_MCP_ALLOW_WRITE'),
    allowRealmAdmin: flag(values, 'KEYCLOAK_MCP_ALLOW_REALM_ADMIN'),
    allowSensitiveReads: flag(values, 'KEYCLOAK_MCP_ALLOW_SENSITIVE_READS'),
    allowIrreversible: flag(values, 'KEYCLOAK_MCP_ALLOW_IRREVERSIBLE'),
    lockDatabaseUrl: values.KEYCLOAK_MCP_LOCK_DATABASE_URL || '',
    singleWriter: flag(values, 'KEYCLOAK_MCP_SINGLE_WRITER'),
    journalDir: values.KEYCLOAK_MCP_JOURNAL_DIR || '',
    extensionCatalogPath: values.KEYCLOAK_MCP_EXTENSION_CATALOG || '',
    catalogVersion: values.KEYCLOAK_MCP_CATALOG_VERSION || 'latest',
    maxBodyBytes: bodyLimit(values.KEYCLOAK_MCP_MAX_BODY_BYTES),
    secretAttributes: nameList(values, 'KEYCLOAK_MCP_SECRET_ATTRIBUTES'),
  };
}
