#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './adapters/mcp.js';
import { configFromEnv } from './config.js';
import { KeycloakAdmin } from './keycloak-admin.js';

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
