// JSON.parse rounds integers beyond 2^53 and respells numbers (1.0 becomes 1, 1e2 becomes 100). A number
// that would not print back as its source text is kept as that text with JSON.rawJSON, which
// JSON.stringify writes out verbatim; every other number parses as usual.
export function parseLosslessJson(text) {
  return JSON.parse(text, (_key, value, context) =>
    (typeof value === 'number' && String(value) !== context.source ? JSON.rawJSON(context.source) : value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !JSON.isRawJSON(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// A deep, frozen copy of `value` as JSON carries it, with numbers kept exact, so nobody holding the
// original can change the copy afterwards.
export function frozenJsonCopy(value) {
  return value === undefined ? undefined : deepFreeze(parseLosslessJson(JSON.stringify(value)));
}

// Keycloak reads JSON request bodies with Jackson, which takes the encoding from a byte-order mark, else
// from which of the first bytes are zero, since JSON starts with an ASCII character, and else reads UTF-8
// (jackson-core ByteSourceJsonBootstrapper#detectEncoding). The 32-bit forms come first: FF FE also opens
// the UTF-32LE mark, and a zero second byte also opens UTF-32LE text.
const BYTE_ORDER_MARKS = [
  ['utf-32be', [0x00, 0x00, 0xfe, 0xff]], ['utf-32le', [0xff, 0xfe, 0x00, 0x00]],
  ['utf-16be', [0xfe, 0xff]], ['utf-16le', [0xff, 0xfe]], ['utf-8', [0xef, 0xbb, 0xbf]],
];
const ZERO_BYTES = [['utf-32be', [0, 1, 2]], ['utf-32le', [1, 2, 3]], ['utf-16be', [0]], ['utf-16le', [1]]];

function jsonEncodingOf(bytes) {
  const marked = BYTE_ORDER_MARKS.find(([, mark]) => mark.every((byte, index) => bytes[index] === byte));
  if (marked) return { encoding: marked[0], start: marked[1].length };
  const zeroed = ZERO_BYTES.find(([, positions]) => positions.every(index => bytes[index] === 0));
  return { encoding: zeroed?.[0] ?? 'utf-8', start: 0 };
}

// Throws on bytes that are not valid in `encoding`; a mark after the first stays in the text.
function decodeStrictly(bytes, encoding) {
  if (!encoding.startsWith('utf-32')) return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
  if (bytes.length % 4 !== 0) throw new Error('truncated UTF-32 text');
  const read = encoding === 'utf-32le' ? 'readUInt32LE' : 'readUInt32BE';
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 4) text += String.fromCodePoint(bytes[read](offset));
  return text;
}

// The one JSON document in `bytes`, decoded in the encoding Jackson detects. Bytes Jackson might read
// differently throw instead of being guessed at: invalid sequences, which Jackson may decode anyway (it
// reads overlong UTF-8), and anything after the document, which Jackson ignores.
export function readJsonBytes(bytes) {
  const { encoding, start } = jsonEncodingOf(bytes);
  return parseLosslessJson(decodeStrictly(bytes.subarray(start), encoding));
}

export const UNREADABLE_JSON = Symbol('unreadable JSON body');

// The JSON value a call's args send as its body: `body` itself, or `bodyBase64` read as above. A
// `bodyBase64` that cannot be read gives UNREADABLE_JSON when Keycloak reads the body as JSON
// (`sentAsJson`), and undefined for a text or other body, which is judged only when it holds JSON.
export function jsonBodyOf(args, sentAsJson) {
  if (args.bodyBase64 === undefined) return args.body;
  try { return readJsonBytes(Buffer.from(args.bodyBase64, 'base64')); } catch { return sentAsJson ? UNREADABLE_JSON : undefined; }
}
