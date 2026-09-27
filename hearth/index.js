import { configFromEnv, describeOperation, describeSchema, KeycloakAdmin, listOperations } from '../src/keycloak.js';
import { runWorkflow } from '../src/workflow.js';
import { isAbsolute } from 'node:path';

function tool(name, description, parameters, handler) {
  return {
    name, label: name, description, parameters,
    async execute(_callId, params) {
      try {
        const value = await handler(params ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : 'unknown error'}` }] };
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
      throw new Error('Hearth configPath must be an absolute path');
    const admin = new KeycloakAdmin(configFromEnv(configPath ? { KEYCLOAK_MCP_CONFIG: configPath } : process.env));
    const definitions = [
      tool('keycloak_search_operations', 'Search the pinned Keycloak Admin REST catalog.', {
        type: 'object', properties: { search: { type: 'string' }, tag: { type: 'string' }, method: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      }, p => listOperations(p, admin.catalog)),
      tool('keycloak_describe_operation', 'Describe one exact operation.', {
        type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'],
      }, p => describeOperation(p.operation, admin.catalog)),
      tool('keycloak_describe_schema', 'Expand a referenced Keycloak representation.', {
        type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
      }, p => describeSchema(p.name, admin.catalog)),
      tool('keycloak_read', 'Call a read-only catalog operation in the configured realm.', {
        type: 'object', properties: { operation: { type: 'string' }, args: { type: 'object' } }, required: ['operation'],
      }, p => admin.invoke(p.operation, p.args)),
      tool('keycloak_workflow', 'Preflight by default; execute compensated steps only when execute=true.', {
        type: 'object', properties: { steps: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 20 }, execute: { type: 'boolean' } }, required: ['steps'],
      }, p => runWorkflow(admin, p.steps, { dryRun: p.execute !== true })),
    ];
    for (const definition of definitions) api.registerTool(definition, { name: definition.name });
  },
};
