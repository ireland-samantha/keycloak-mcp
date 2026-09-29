import { DEFAULT_BODY_BYTES } from '../config.js';
import { parseLosslessJson } from '../internal/json.js';
import { REDACTED_ENDPOINT } from '../internal/redaction.js';
import { isSensitiveEndpoint } from '../policy/classify.js';
import { redactResponse, redactText } from '../policy/redaction.js';
import { discardBody, readLimitedBody } from './body.js';
import { decodeText, isJsonType, isTextType, mediaTypeOf } from '../internal/media-type.js';

function decodeValue(bytes, header, op, config) {
  if (isSensitiveEndpoint(op) && !config.allowSensitiveReads) return REDACTED_ENDPOINT;
  const contentType = mediaTypeOf(header);
  if (isJsonType(contentType)) {
    let value;
    try { value = parseLosslessJson(decodeText(bytes, header)); } catch { throw new Error('Keycloak returned invalid JSON'); }
    return config.allowSensitiveReads ? value : redactResponse(value, op, config.secretAttributes);
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

const ERROR_BODY_LIMIT = 4 * 1024;
const ERROR_DETAIL_CHARS = 300;

// Keycloak's own explanation of a failed request: the error, errorMessage and error_description fields
// of its JSON error body (ErrorRepresentation or an OAuth error), joined into one line, redacted like a
// response unless sensitive reads are allowed, and cut to 300 characters. Empty when it gave none.
export async function errorDetail(response, config) {
  const header = response.headers.get('content-type');
  if (!isJsonType(mediaTypeOf(header))) {
    await discardBody(response);
    return '';
  }
  let body;
  try { body = JSON.parse(decodeText(await readLimitedBody(response, ERROR_BODY_LIMIT), header)); } catch { return ''; }
  const parts = [body?.error, body?.errorMessage, body?.error_description].filter(part => typeof part === 'string' && part.trim());
  const text = [...new Set(parts)].join(': ').replace(/\s+/g, ' ').trim();
  const shown = config.allowSensitiveReads ? text : redactText(text, config.secretAttributes);
  return shown.length > ERROR_DETAIL_CHARS ? `${shown.slice(0, ERROR_DETAIL_CHARS - 1)}…` : shown;
}

// The error for a failed operation response, with Keycloak's explanation when it gave one.
export async function operationFailure(response, { attempts, config }) {
  const detail = await errorDetail(response, config);
  return new Error(`Keycloak operation failed (HTTP ${response.status}; attempts ${attempts})${detail ? `: ${detail}` : ''}`);
}
