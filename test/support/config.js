import { configFromEnv } from '../../src/api.js';
import { privateTempDir } from './temp.js';

export const testEnv = Object.freeze({
  KEYCLOAK_BASE_URL: 'https://id.example.com/auth',
  KEYCLOAK_REALM: 'test-realm',
  KEYCLOAK_AUTH_REALM: 'master',
  KEYCLOAK_CLIENT_ID: 'mcp-service',
  KEYCLOAK_CLIENT_SECRET: 'test-secret',
});

let journalDir;

// Without KEYCLOAK_MCP_JOURNAL_DIR an executed workflow writes its receipt under
// ~/.local/state/keycloak-mcp, so every test config points at a private temp directory.
export function testConfig(overrides = {}) {
  journalDir ??= privateTempDir('keycloak-mcp-journal-');
  return configFromEnv({ ...testEnv, KEYCLOAK_MCP_JOURNAL_DIR: journalDir, ...overrides });
}
