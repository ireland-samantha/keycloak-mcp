import { parseLosslessJson } from '../internal/json.js';
import { REDACTED } from '../internal/redaction.js';
import { CUSTOM_KEY_MAPS, FIELD_REDACTIONS, KEYCLOAK_OWN_MASKS, SECRET_FIELDS, SECRET_VALUE_SHAPES } from './table.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value);
const isKeptAsSent = text => text === KEYCLOAK_OWN_MASKS.mask || KEYCLOAK_OWN_MASKS.vault.test(text);
const looksLikeJson = text => /^\s*[[{]/.test(text);

function matches(rule, holder, name) {
  return (rule.in === undefined || rule.in === holder) && (rule.field === name || (rule.suffix !== undefined && name.endsWith(rule.suffix)));
}

// Returns `original` when no element changed, so callers can tell whether anything was redacted.
const unchangedOr = (original, items) => (items.every((item, index) => item === original[index]) ? original : items);

// A secret keeps its JSON type: a string becomes the marker and a list of strings a list of markers.
// Anything else, such as ConfigPropertyRepresentation.secret, a boolean flag, is not a secret.
function mask(value) {
  if (typeof value === 'string') return isKeptAsSent(value) ? value : REDACTED;
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return unchangedOr(value, value.map(mask));
  return value;
}

class Redactor {
  constructor(op, secretAttributes) {
    this.pathFields = op && Object.hasOwn(FIELD_REDACTIONS, op.path) ? FIELD_REDACTIONS[op.path].fields : [];
    this.secretAttributes = secretAttributes;
  }

  isSecretField(holder, name, object) {
    return SECRET_FIELDS.some(rule => matches(rule, holder, name)) || this.pathFields.includes(name) ||
      (CUSTOM_KEY_MAPS.holders.includes(holder) && this.secretAttributes.includes(name)) ||
      (typeof object.kty === 'string' && SECRET_VALUE_SHAPES.jwkPrivateMembers.members.includes(name));
  }

  // `holder` is the key under which `value` sits; list items share their list's key.
  redact(value, holder = null) {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return unchangedOr(value, value.map(item => this.redact(item, holder)));
    if (!isObject(value)) return value;
    const entries = Object.entries(value);
    const redacted = entries.map(([name, child]) => (this.isSecretField(holder, name, value) ? mask(child) : this.redact(child, name)));
    return redacted.every((child, index) => child === entries[index][1]) ? value
      : Object.fromEntries(entries.map(([name], index) => [name, redacted[index]]));
  }

  redactText(text) {
    if (SECRET_VALUE_SHAPES.pemPrivateKey.pattern.test(text)) return REDACTED;
    if (!looksLikeJson(text)) return text;
    let parsed;
    try { parsed = parseLosslessJson(text); } catch { return text; }
    const redacted = this.redact(parsed);
    return redacted === parsed ? text : JSON.stringify(redacted);
  }
}

// A parsed JSON response of `op` with every secret the policy table knows replaced by the marker, and
// with the attribute and config keys an operator names in `secretAttributes` treated as secrets too.
export function redactResponse(value, op, secretAttributes = []) {
  return new Redactor(op, secretAttributes).redact(value);
}

// Free text, such as an error message, with any secret-shaped value in it replaced by the marker.
export function redactText(text, secretAttributes = []) {
  return new Redactor(null, secretAttributes).redactText(text);
}
