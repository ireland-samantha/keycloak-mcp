import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { describeOperation, describeSchema, listOperations } from './keycloak.js';
import { runWorkflow } from './workflow.js';

const argsSchema = z.object({
  path: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  bodyBase64: z.string().optional(),
  contentType: z.string().optional(),
  accept: z.string().optional(),
});
const stepSchema = z.object({
  operation: z.string(),
  args: argsSchema.optional(),
  compensate: z.object({ operation: z.string(), args: argsSchema.optional() }).optional(),
  irreversible: z.boolean().optional(),
});

function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function guarded(fn) {
  return async args => {
    try { return result(await fn(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'unknown error' }] }; }
  };
}

export function createServer(admin) {
  const server = new McpServer({ name: 'keycloak-mcp', version: '0.1.1' });
  server.registerTool('keycloak_search_operations', {
    description: 'Search the pinned Keycloak Admin REST and configured SPI operation catalog by path, summary, tag, or HTTP method.',
    inputSchema: z.object({ search: z.string().optional(), tag: z.string().optional(), method: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) }),
    annotations: { readOnlyHint: true },
  }, guarded(args => listOperations(args, admin.catalog)));
  server.registerTool('keycloak_describe_operation', {
    description: 'Get required path and query parameters, request types, and summary for one exact catalog operation.',
    inputSchema: z.object({ operation: z.string() }),
    annotations: { readOnlyHint: true },
  }, guarded(args => describeOperation(args.operation, admin.catalog)));
  server.registerTool('keycloak_describe_schema', {
    description: 'Expand a Keycloak representation named in an operation request or response schema reference.',
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
  }, guarded(args => describeSchema(args.name, admin.catalog)));
  server.registerTool('keycloak_read', {
    description: 'Call a read-only catalog operation in the configured realm with a service-account token. This includes GET and the client-description converter POST. Sensitive JSON fields are redacted by default.',
    inputSchema: z.object({ operation: z.string(), args: argsSchema.optional() }),
    annotations: { readOnlyHint: true },
  }, guarded(args => admin.invoke(args.operation, args.args)));
  server.registerTool('keycloak_workflow', {
    description: 'Preflight a Keycloak workflow by default. Set execute=true to run; every mutation needs an explicit compensation. Failed steps may have committed and are reported as uncertain.',
    inputSchema: z.object({ steps: z.array(stepSchema).min(1).max(20), execute: z.boolean().default(false) }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, guarded(args => runWorkflow(admin, args.steps, { dryRun: !args.execute })));
  return server;
}
