export const REDACTED = '[REDACTED]';
export const REDACTED_ENDPOINT = '[REDACTED: sensitive endpoint]';

// Replaces the value of every object key, at any depth, for which isSensitive(key) holds. A number kept
// as raw JSON text is a value, not an object to walk.
export function redactKeys(value, isSensitive) {
  if (JSON.isRawJSON(value)) return value;
  if (Array.isArray(value)) return value.map(item => redactKeys(item, isSensitive));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, isSensitive(key) ? REDACTED : redactKeys(child, isSensitive)]));
  return value;
}
