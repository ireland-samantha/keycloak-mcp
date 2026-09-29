// JSON.parse rounds integers beyond 2^53 and respells numbers (1.0 becomes 1, 1e2 becomes 100). A number
// that would not print back as its source text is kept as that text with JSON.rawJSON, which
// JSON.stringify writes out verbatim; every other number parses as usual.
export function parseLosslessJson(text) {
  return JSON.parse(text, (_key, value, context) =>
    (typeof value === 'number' && String(value) !== context.source ? JSON.rawJSON(context.source) : value));
}
