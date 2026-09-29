import { isTextType } from './media-type.js';

const limitExceeded = () => new Error('request body exceeds configured limit');

// Releases an unread response body; a failed cancel must not mask the caller's own error.
export async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* the caller reports its own error */ }
}

// Reads a response body, stopping the stream as soon as it crosses `limit` bytes.
export async function readLimitedBody(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await discardBody(response);
    throw new Error(`response exceeds configured limit (HTTP ${response.status})`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* the limit error remains authoritative */ }
        throw new Error(`response exceeds configured limit (HTTP ${response.status})`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

// Checks the decoded size before decoding, so an oversized value is never allocated.
function decodeBase64Bounded(value, limit, label) {
  if (typeof value !== 'string') throw new Error(`invalid ${label}`);
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (Math.floor(value.length / 4) * 3 - padding > limit) throw limitExceeded();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`invalid ${label}`);
  return Buffer.from(value, 'base64');
}

// Text fields are strings; a file field is { filename, contentType, base64 }. Each field is charged
// a 1 KiB allowance for its part headers on top of its content.
function encodeMultipart(fields, limit) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 32)
    throw new Error('multipart body must be an object with at most 32 fields');
  const form = new FormData();
  let bytes = 1024;
  for (const [name, value] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('invalid multipart field name');
    bytes += 1024 + Buffer.byteLength(name);
    if (bytes > limit) throw limitExceeded();
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value);
      if (bytes > limit) throw limitExceeded();
      form.append(name, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const { filename, contentType, base64 } = value;
      if (Object.keys(value).some(key => !['filename', 'contentType', 'base64'].includes(key)) ||
        typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename)) throw new Error('invalid multipart filename');
      if (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new Error('invalid multipart content type');
      bytes += Buffer.byteLength(filename) + Buffer.byteLength(contentType);
      if (bytes > limit) throw limitExceeded();
      const file = decodeBase64Bounded(base64, limit - bytes, 'multipart base64');
      bytes += file.length;
      form.append(name, new Blob([file], { type: contentType }), filename);
    } else throw new Error('multipart fields must be text or a base64 file');
    if (bytes > limit) throw limitExceeded();
  }
  return form;
}

function encodeForm(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('form body must be an object');
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error('form values must be scalar');
      form.append(name, String(item));
    }
  }
  return form.toString();
}

function serialize(contentType, args, limit) {
  if (args.bodyBase64 !== undefined) return decodeBase64Bounded(args.bodyBase64, limit, 'base64 body');
  if (contentType === 'application/json') return JSON.stringify(args.body);
  if (contentType === 'application/x-www-form-urlencoded') return encodeForm(args.body);
  if (typeof args.body === 'string') return args.body;
  throw new Error('non-JSON bodies require text or bodyBase64');
}

// Without args.contentType, a text body goes as the operation's text/* type, else its XML or YAML type,
// and any other body as JSON when declared; failing those, as the first declared type.
function defaultContentType(op, args) {
  if (args.bodyBase64 !== undefined) return op.requestTypes[0];
  const preferred = typeof args.body === 'string'
    ? [...op.requestTypes.filter(type => type.startsWith('text/')), ...op.requestTypes.filter(isTextType)]
    : op.requestTypes.filter(type => type === 'application/json');
  return preferred[0] ?? op.requestTypes[0];
}

// Encodes args.body or args.bodyBase64 as one of the operation's declared request types. A multipart
// body carries no content type: fetch sets it together with the boundary.
export function encodeBody(op, args, limit) {
  if (!op.requestTypes.length) throw new Error('operation does not declare a request body');
  const contentType = args.contentType ?? defaultContentType(op, args);
  if (!op.requestTypes.includes(contentType)) throw new Error('content type is not declared for this operation');
  if (args.body !== undefined && args.bodyBase64 !== undefined) throw new Error('choose body or bodyBase64');
  if (contentType === 'multipart/form-data') {
    if (args.bodyBase64 !== undefined) throw new Error('multipart requires structured fields');
    return { body: encodeMultipart(args.body, limit) };
  }
  const body = serialize(contentType, args, limit);
  if (Buffer.byteLength(body) > limit) throw limitExceeded();
  return { body, contentType };
}
