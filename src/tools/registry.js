import * as z from 'zod/v4';
import { describeOperation, describeSchema, listOperations } from '../catalog/index.js';
import { runWorkflow } from '../workflow/runner.js';

const operationArgs = z.object({
  path: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  bodyBase64: z.string().optional(),
  contentType: z.string().optional(),
  accept: z.string().optional(),
});

const workflowStep = z.object({
  operation: z.string(),
  args: operationArgs.optional(),
  compensate: z.object({ operation: z.string(), args: operationArgs.optional() }).optional(),
  irreversible: z.boolean().optional(),
});

// The tools every adapter serves, in the order they are registered. `input` is the zod schema of a
// tool's arguments and `run(admin, input)` performs the call for a KeycloakAdmin.
export const tools = [
  {
    name: 'keycloak_search_operations',
    description: 'Search the pinned Keycloak Admin REST and configured SPI operation catalog by path, summary, tag, or HTTP method.',
    readOnly: true,
    input: z.object({ search: z.string().optional(), tag: z.string().optional(), method: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) }),
    run: (admin, input) => listOperations(input, admin.catalog),
  },
  {
    name: 'keycloak_describe_operation',
    description: 'Get required path and query parameters, request types, and summary for one exact catalog operation.',
    readOnly: true,
    input: z.object({ operation: z.string() }),
    run: (admin, input) => describeOperation(input.operation, admin.catalog),
  },
  {
    name: 'keycloak_describe_schema',
    description: 'Expand a Keycloak representation named in an operation request or response schema reference.',
    readOnly: true,
    input: z.object({ name: z.string() }),
    run: (admin, input) => describeSchema(input.name, admin.catalog),
  },
  {
    name: 'keycloak_read',
    description: 'Call a read-only catalog operation in the configured realm with a service-account token. This includes GET and the client-description converter POST. Sensitive JSON fields are redacted by default.',
    readOnly: true,
    input: z.object({ operation: z.string(), args: operationArgs.optional() }),
    run: (admin, input) => admin.invoke(input.operation, input.args),
  },
  {
    name: 'keycloak_workflow',
    description: 'Preflight a Keycloak workflow by default. Set execute=true to run; every mutation needs an explicit compensation. Failed steps may have committed and are reported as uncertain.',
    readOnly: false,
    input: z.object({ steps: z.array(workflowStep).min(1).max(20), execute: z.boolean().default(false) }),
    run: (admin, input) => runWorkflow(admin, input.steps, { dryRun: input.execute !== true }),
  },
];

export const toolNames = tools.map(tool => tool.name);

// The tool's arguments as JSON Schema, the same document the MCP SDK advertises without its $schema dialect.
export function toolParameters(tool) {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.input, { io: 'input' });
  return schema;
}

const describeIssue = issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message);

// Validates and defaults a tool's arguments, refusing invalid ones in the MCP SDK's wording
// (validateToolInput in @modelcontextprotocol/server), so every adapter answers alike.
export function parseToolInput(tool, input) {
  const parsed = tool.input.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw new Error(`Input validation error: Invalid arguments for tool ${tool.name}: ${parsed.error.issues.map(describeIssue).join(', ')}`);
}
