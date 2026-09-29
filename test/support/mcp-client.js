import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configFromEnv, KeycloakAdmin } from '../../src/api.js';
import { createServer } from '../../src/server.js';

// Negotiated unless a test asks for another revision (lifecycle A1 also covers 2025-11-25).
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

// A minimal JSON-RPC client over any transport: `send` delivers a message, `receive` is fed replies.
export class McpSession {
  #pending = new Map();
  #nextId = 1;
  #close;

  constructor(send, { close = async () => {}, timeoutMs = 15_000 } = {}) {
    this.send = send;
    this.#close = close;
    this.timeoutMs = timeoutMs;
  }

  close() { return this.#close(); }

  // Rejects every outstanding request, e.g. because the server process exited.
  abort(error) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  receive(message) {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} got no response within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.send({ jsonrpc: '2.0', id, method, params })).catch(error => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method) { return this.send({ jsonrpc: '2.0', method }); }

  async initialize(protocolVersion = DEFAULT_PROTOCOL_VERSION) {
    const response = await this.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'keycloak-mcp-tests', version: '0' } });
    if (response.error) throw new Error(`initialize failed: ${response.error.message}`);
    await this.notify('notifications/initialized');
    return response.result;
  }

  async listTools() { return (await this.request('tools/list', {})).result.tools; }

  // `text` is the tool output as sent; `value` is that text parsed as JSON for successful calls.
  async call(name, args = {}, options) {
    const response = await this.request('tools/call', { name, arguments: args }, options);
    if (response.error) throw new Error(`tools/call ${name} failed: ${response.error.message}`);
    const text = response.result.content.map(item => item.text).join('');
    const isError = response.result.isError === true;
    return { isError, text, value: isError ? undefined : JSON.parse(text) };
  }
}

// The same MCP server the stdio entry point builds, connected in memory; `settings` are KEYCLOAK_* values.
export async function connectInProcess(settings) {
  const admin = new KeycloakAdmin(configFromEnv(settings));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const session = new McpSession(message => clientSide.send(message), { close: () => clientSide.close() });
  clientSide.onmessage = message => session.receive(message);
  await createServer(admin).connect(serverSide);
  await clientSide.start();
  await session.initialize();
  return session;
}
