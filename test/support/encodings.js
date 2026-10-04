// Encodings Jackson, and so Keycloak, reads a JSON body in besides plain UTF-8.

export const utf16be = text => Buffer.from(text, 'utf16le').swap16();

export const utf32 = (text, order) => Buffer.concat([...text].map(char => {
  const bytes = Buffer.alloc(4);
  bytes[`writeUInt32${order}`](char.codePointAt(0));
  return bytes;
}));

export const withMark = (mark, bytes) => Buffer.concat([Buffer.from(mark), bytes]);

export const base64 = bytes => bytes.toString('base64');
