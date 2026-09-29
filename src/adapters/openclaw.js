import { isAbsolute } from 'node:path';
import { configFromEnv } from '../config.js';
import { KeycloakAdmin } from '../keycloak-admin.js';
import { parseToolInput, toolParameters, tools } from '../tools/registry.js';

function openClawTool(tool, admin) {
  return {
    name: tool.name, label: tool.name, description: tool.description, parameters: toolParameters(tool),
    async execute(_callId, params) {
      try {
        const value = await tool.run(admin, parseToolInput(tool, params));
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        // OpenClaw grades a tool call from details; ok=false marks a refusal or failure as failed.
        return { content: [{ type: 'text', text: `Error: ${message}` }], details: { ok: false, error: message } };
      }
    },
  };
}

export default {
  id: 'keycloak-mcp',
  name: 'Keycloak Admin',
  description: 'Service-account Keycloak Admin REST catalog, reads, and compensating workflows.',
  register(api) {
    const configPath = api.pluginConfig?.configPath;
    if (configPath !== undefined && (typeof configPath !== 'string' || !isAbsolute(configPath)))
      throw new Error('OpenClaw configPath must be an absolute path');
    const admin = new KeycloakAdmin(configFromEnv(configPath ? { KEYCLOAK_MCP_CONFIG: configPath } : process.env));
    for (const tool of tools) {
      const definition = openClawTool(tool, admin);
      api.registerTool(definition, { name: definition.name });
    }
  },
};
