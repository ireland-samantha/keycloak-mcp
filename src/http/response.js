import { DEFAULT_BODY_BYTES } from '../config.js';
import { parseLosslessJson } from '../internal/json.js';
import { REDACTED_ENDPOINT } from '../internal/redaction.js';
import { isSensitiveEndpoint } from '../policy/classify.js';
import { redactResponse } from '../policy/redaction.js';
import { readLimitedBody } from './body.js';
import { decodeText, isJsonType, isTextType, mediaTypeOf } from './media-type.js';

function decodeValue(bytes, header, op, config) {
  if (isSensitiveEndpoint(op) && !config.allowSensitiveReads) return REDACTED_ENDPOINT;
  const contentType = mediaTypeOf(header);
  if (isJsonType(contentType)) {
    let value;
    try { value = parseLosslessJson(decodeText(bytes, header)); } catch { throw new Error('Keycloak returned invalid JSON'); }
    return config.allowSensitiveReads ? value : redactResponse(value, op);
  }
  if (isTextType(contentType)) return decodeText(bytes, header);
  return { base64: bytes.toString('base64'), contentType };
}

// Reads a successful response as { status, attempts?, location?, contentType?, value? }. A body is reported
// with its media type and its value: JSON parsed, text kept as text, anything else as base64, and sensitive
// content redacted unless sensitive reads are allowed. An empty body has neither, so it cannot be mistaken
// for a JSON null.
export async function readResult(response, { op, attempts, config }) {
  const bytes = await readLimitedBody(response, config.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  const header = response.headers.get('content-type');
  const location = response.headers.get('location');
  return { status: response.status, ...(attempts > 1 ? { attempts } : {}), ...(location ? { location } : {}),
    ...(bytes.length ? { contentType: mediaTypeOf(header), value: decodeValue(bytes, header, op, config) } : {}) };
}
