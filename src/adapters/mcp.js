import { McpServer } from '@modelcontextprotocol/server';
import { packageInfo } from '../meta.js';
import { tools } from '../tools/registry.js';

const annotations = tool => (tool.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true });

function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function guarded(fn) {
  return async args => {
    try { return result(await fn(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'unknown error' }] }; }
  };
}

export function createServer(admin) {
  const server = new McpServer({ name: packageInfo.name, version: packageInfo.version });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations: annotations(tool) },
      guarded(input => tool.run(admin, input)));
  }
  return server;
}
