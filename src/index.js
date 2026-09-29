#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './adapters/mcp.js';
import { configFromEnv } from './config.js';
import { KeycloakAdmin } from './keycloak-admin.js';

function startAdmin() {
  try {
    return new KeycloakAdmin(configFromEnv());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'configuration failed');
    process.exitCode = 1;
    return null;
  }
}

const admin = startAdmin();
// serveStdio returns a handle, not a promise: transport faults are only reported through onerror,
// and the process exits once stdin closes and the transport has shut down.
if (admin) serveStdio(() => createServer(admin), { onerror: error => console.error(`MCP transport error: ${error.message}`) });
