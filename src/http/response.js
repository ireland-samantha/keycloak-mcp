import { DEFAULT_BODY_BYTES } from '../config.js';
import { redactKeys, REDACTED_ENDPOINT } from '../internal/redaction.js';
import { isSensitiveEndpoint, isSensitiveField } from '../policy/classify.js';
import { readLimitedBody } from './body.js';
import { decodeText, isJsonType, isTextType, mediaTypeOf } from './media-type.js';

function decodeValue(bytes, header, op, config) {
  if (!bytes.length) return null;
  if (isSensitiveEndpoint(op) && !config.allowSensitiveReads) return REDACTED_ENDPOINT;
  const contentType = mediaTypeOf(header);
  if (isJsonType(contentType)) {
    let value;
    try { value = JSON.parse(decodeText(bytes, header)); } catch { throw new Error('Keycloak returned invalid JSON'); }
    return config.allowSensitiveReads ? value : redactKeys(value, name => isSensitiveField(op, name));
  }
  if (isTextType(contentType)) return decodeText(bytes, header);
  return { base64: bytes.toString('base64'), contentType };
}

// Reads a successful response as { status, attempts?, location?, value }; JSON is parsed, text kept as
// text, anything else returned as base64, and sensitive content redacted unless sensitive reads are allowed.
export async function readResult(response, { op, attempts, config }) {
  const bytes = await readLimitedBody(response, config.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  const value = decodeValue(bytes, response.headers.get('content-type'), op, config);
  const location = response.headers.get('location');
  return { status: response.status, ...(attempts > 1 ? { attempts } : {}), ...(location ? { location } : {}), value };
}
