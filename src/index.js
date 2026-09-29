#!/usr/bin/env node
import { assertStdioBodyLimit, serveStdioServer } from './adapters/stdio.js';
import { configFromEnv } from './config.js';
import { KeycloakAdmin } from './keycloak-admin.js';

function startAdmin() {
  try {
    const config = configFromEnv();
    assertStdioBodyLimit(config);
    return new KeycloakAdmin(config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'configuration failed');
    process.exitCode = 1;
    return null;
  }
}

const admin = startAdmin();
// Transport faults are only reported through onerror; the process exits once stdin closes and the
// transport has shut down.
if (admin) serveStdioServer(admin, { onerror: error => console.error(`MCP transport error: ${error.message}`) });
