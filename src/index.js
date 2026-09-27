#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configFromEnv, KeycloakAdmin } from './keycloak.js';
import { createServer } from './server.js';

try {
  const admin = new KeycloakAdmin(configFromEnv());
  void serveStdio(() => createServer(admin)).catch(error => {
    console.error(error instanceof Error ? error.message : 'MCP transport failed');
    process.exitCode = 1;
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'configuration failed');
  process.exitCode = 1;
}
