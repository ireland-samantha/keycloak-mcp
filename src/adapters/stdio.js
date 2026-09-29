import { Transform } from 'node:stream';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './mcp.js';

// The SDK reads at most 10 MiB per stdio message (STDIO_DEFAULT_MAX_BUFFER_SIZE in
// @modelcontextprotocol/server 2.1.0), and its clients read our replies with the same default.
export const STDIO_MESSAGE_BYTES = 10 * 1024 * 1024;
// The largest body that fits one message as base64, with 64 KiB left for the JSON-RPC envelope.
export const STDIO_BODY_BYTES = Math.floor((STDIO_MESSAGE_BYTES - 64 * 1024) / 4) * 3;
const INVALID_REQUEST = -32600;

// Refuses a body limit that stdio could not carry, which would otherwise end the session mid-call.
export function assertStdioBodyLimit(config) {
  if (config.maxBodyBytes > STDIO_BODY_BYTES)
    throw new Error(`KEYCLOAK_MCP_MAX_BODY_BYTES exceeds ${STDIO_BODY_BYTES}, the largest body one MCP stdio message can carry`);
}

// Passes stdin on one whole newline-terminated message at a time. The SDK's read buffer closes the
// connection when a message outgrows it and re-copies its buffer for every chunk it appends; a message
// longer than `limit` is dropped here instead and reported through onOversized.
class MessageFrames extends Transform {
  #limit;
  #onOversized;
  #pieces = [];
  #size = 0;
  #dropping = false;

  constructor(limit, onOversized) {
    super();
    this.#limit = limit;
    this.#onOversized = onOversized;
  }

  _transform(chunk, _encoding, done) {
    let start = 0;
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      this.#take(chunk.subarray(start, end + 1));
      this.#endMessage();
      start = end + 1;
    }
    if (start < chunk.length) this.#take(chunk.subarray(start));
    done();
  }

  #take(piece) {
    if (this.#dropping) return;
    this.#size += piece.length;
    if (this.#size <= this.#limit) {
      this.#pieces.push(piece);
      return;
    }
    this.#dropping = true;
    this.#pieces = [];
    this.#onOversized();
  }

  #endMessage() {
    if (!this.#dropping) this.push(Buffer.concat(this.#pieces, this.#size));
    this.#pieces = [];
    this.#size = 0;
    this.#dropping = false;
  }
}

// Serves the MCP tools over this process's stdin and stdout until stdin closes.
export function serveStdioServer(admin, { onerror }) {
  const frames = new MessageFrames(STDIO_MESSAGE_BYTES, () => {
    const message = `dropped an MCP message larger than ${STDIO_MESSAGE_BYTES} bytes`;
    onerror(new Error(message));
    // The request's id is inside the dropped bytes, so the error cannot name it.
    transport.send({ jsonrpc: '2.0', error: { code: INVALID_REQUEST, message } }).catch(onerror);
  });
  process.stdin.on('error', error => frames.destroy(error));
  const transport = new StdioServerTransport(process.stdin.pipe(frames), process.stdout, { maxBufferSize: STDIO_MESSAGE_BYTES });
  return serveStdio(() => createServer(admin, { maxMessageBytes: STDIO_MESSAGE_BYTES }), { transport, onerror });
}
