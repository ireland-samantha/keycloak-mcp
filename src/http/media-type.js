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
