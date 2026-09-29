// Media types compare case-insensitively and without their parameters (RFC 9110 section 8.3.1).
export const mediaTypeOf = header => (header ?? '').split(';')[0].trim().toLowerCase();

export const isJsonType = type => type === 'application/json' || type.endsWith('+json');

// Types whose bodies are read and written as text rather than JSON or bytes.
export const isTextType = type => type.startsWith('text/') || type.includes('xml') || type.includes('yaml');

// Decodes a body in the charset its Content-Type names, or UTF-8 when it names none that TextDecoder knows.
export function decodeText(bytes, header) {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(header ?? '')?.[1];
  try { return new TextDecoder(charset ?? 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

// The declared type a call's args send their body as: args.contentType, else, for a text body, the
// operation's text/* type, else its XML or YAML type; for any other structured body JSON when declared;
// failing those, and always for bodyBase64, the first declared type.
export function requestContentType(op, args) {
  if (args.contentType !== undefined) return args.contentType;
  if (args.bodyBase64 !== undefined) return op.requestTypes[0];
  const preferred = typeof args.body === 'string'
    ? [...op.requestTypes.filter(type => type.startsWith('text/')), ...op.requestTypes.filter(isTextType)]
    : op.requestTypes.filter(type => type === 'application/json');
  return preferred[0] ?? op.requestTypes[0];
}
