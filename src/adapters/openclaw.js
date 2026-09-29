import { isAbsolute } from 'node:path';
import { configFromEnv } from '../config.js';
import { KeycloakAdmin } from '../keycloak-admin.js';
import { tools } from '../tools/registry.js';

// OpenClaw keeps the descriptions and JSON parameters it has always advertised and passes the
// parameters to each tool unvalidated, unlike the MCP adapter; ARCH-4 aligns it with the registry.
const advertised = {
  keycloak_search_operations: { description: 'Search the pinned Keycloak Admin REST catalog.', parameters: {
    type: 'object', properties: { search: { type: 'string' }, tag: { type: 'string' }, method: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
  } },
  keycloak_describe_operation: { description: 'Describe one exact operation.', parameters: {
    type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'],
  } },
  keycloak_describe_schema: { description: 'Expand a referenced Keycloak representation.', parameters: {
    type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
  } },
  keycloak_read: { description: 'Call a read-only catalog operation in the configured realm.', parameters: {
    type: 'object', properties: { operation: { type: 'string' }, args: { type: 'object' } }, required: ['operation'],
  } },
  keycloak_workflow: { description: 'Preflight by default; execute compensated steps only when execute=true.', parameters: {
    type: 'object', properties: { steps: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 20 }, execute: { type: 'boolean' } }, required: ['steps'],
  } },
};

function openClawTool(tool, admin) {
  const { description, parameters } = advertised[tool.name];
  return {
    name: tool.name, label: tool.name, description, parameters,
    async execute(_callId, params) {
      try {
        const value = await tool.run(admin, params ?? {});
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
