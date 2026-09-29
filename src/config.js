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

function realm(name, label) {
  if (!REALM_NAME.test(name)) throw new Error(`${label} has invalid characters`);
  return name;
}

// A KEYCLOAK_MCP_CONFIG file supplies defaults; the environment wins over it.
function settings(env) {
  if (!env.KEYCLOAK_MCP_CONFIG) return env;
  const file = readPrivateJson(env.KEYCLOAK_MCP_CONFIG, 'KEYCLOAK_MCP_CONFIG');
  if (!file || Array.isArray(file) || typeof file !== 'object') throw new Error('KEYCLOAK_MCP_CONFIG must be a JSON object');
  return { ...file, ...env };
}

export function configFromEnv(env = process.env) {
  const values = settings(env);
  return {
    baseUrl: baseUrl(required('KEYCLOAK_BASE_URL', values.KEYCLOAK_BASE_URL)),
    realm: realm(required('KEYCLOAK_REALM', values.KEYCLOAK_REALM), 'KEYCLOAK_REALM'),
    authRealm: realm(values.KEYCLOAK_AUTH_REALM || 'master', 'KEYCLOAK_AUTH_REALM'),
    clientId: required('KEYCLOAK_CLIENT_ID', values.KEYCLOAK_CLIENT_ID),
    clientSecret: required('KEYCLOAK_CLIENT_SECRET', values.KEYCLOAK_CLIENT_SECRET),
    allowWrite: values.KEYCLOAK_MCP_ALLOW_WRITE === 'true',
    allowRealmAdmin: values.KEYCLOAK_MCP_ALLOW_REALM_ADMIN === 'true',
    allowSensitiveReads: values.KEYCLOAK_MCP_ALLOW_SENSITIVE_READS === 'true',
    allowIrreversible: values.KEYCLOAK_MCP_ALLOW_IRREVERSIBLE === 'true',
    lockDatabaseUrl: values.KEYCLOAK_MCP_LOCK_DATABASE_URL || '',
    singleWriter: values.KEYCLOAK_MCP_SINGLE_WRITER === 'true',
    journalDir: values.KEYCLOAK_MCP_JOURNAL_DIR || '',
    extensionCatalogPath: values.KEYCLOAK_MCP_EXTENSION_CATALOG || '',
    catalogVersion: values.KEYCLOAK_MCP_CATALOG_VERSION || 'latest',
    maxBodyBytes: bodyLimit(values.KEYCLOAK_MCP_MAX_BODY_BYTES),
  };
}
