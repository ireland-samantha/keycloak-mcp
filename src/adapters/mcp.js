import { McpServer } from '@modelcontextprotocol/server';
import { packageInfo } from '../meta.js';
import { tools } from '../tools/registry.js';

const annotations = tool => (tool.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true });

// Room for the JSON-RPC envelope around a tool result's text.
const RESULT_ENVELOPE_BYTES = 1024;

// A value becomes the text of one JSON-RPC message, in which that text is escaped once more.
function result(value, maxMessageBytes) {
  const text = JSON.stringify(value);
  const messageBytes = Buffer.byteLength(JSON.stringify(text)) + RESULT_ENVELOPE_BYTES;
  if (messageBytes > maxMessageBytes)
    throw new Error(`the result needs a ${messageBytes}-byte MCP message, more than the ${maxMessageBytes} bytes one message can carry; request less, for example with first and max`);
  return { content: [{ type: 'text', text }] };
}

function guarded(fn, maxMessageBytes) {
  return async args => {
    try { return result(await fn(args), maxMessageBytes); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'unknown error' }] }; }
  };
}

// `maxMessageBytes` bounds each tool result's message, for transports whose peer reads a limited size.
export function createServer(admin, { maxMessageBytes = Infinity } = {}) {
  const server = new McpServer({ name: packageInfo.name, version: packageInfo.version });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations: annotations(tool) },
      guarded(input => tool.run(admin, input), maxMessageBytes));
  }
  return server;
}
