import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonBytes } from '../../src/internal/json.js';
import { utf16be, utf32, withMark } from '../support/encodings.js';

const json = '{"credentials":[{"type":"password","value":"Chosen-1"}],"eventsExpiration":9007199254740993}';

// Every encoding Jackson detects; Keycloak HEAD read each of them on PUT .../events/config.
const encodings = {
  'UTF-8': Buffer.from(json),
  'UTF-8 with a byte-order mark': withMark([0xef, 0xbb, 0xbf], Buffer.from(json)),
  'UTF-16LE': Buffer.from(json, 'utf16le'),
  'UTF-16LE with a byte-order mark': withMark([0xff, 0xfe], Buffer.from(json, 'utf16le')),
  'UTF-16BE': utf16be(json),
  'UTF-16BE with a byte-order mark': withMark([0xfe, 0xff], utf16be(json)),
  'UTF-32LE': utf32(json, 'LE'),
  'UTF-32LE with a byte-order mark': withMark([0xff, 0xfe, 0x00, 0x00], utf32(json, 'LE')),
  'UTF-32BE': utf32(json, 'BE'),
  'UTF-32BE with a byte-order mark': withMark([0x00, 0x00, 0xfe, 0xff], utf32(json, 'BE')),
};

for (const [name, bytes] of Object.entries(encodings)) {
  test(`JSON in ${name} reads as its value, numbers kept exact`, () => {
    assert.equal(JSON.stringify(readJsonBytes(bytes)), json);
  });
}

// Bytes Jackson may still read, some differently from any strict decoder, so none of them is guessed at.
const unreadable = {
  'an overlong UTF-8 sequence, which Jackson decodes as the ASCII letter': Buffer.concat([Buffer.from('{"'), Buffer.from([0xc1, 0xa3]), Buffer.from('redentials":[]}')]),
  'an encoded UTF-16 surrogate in UTF-8': Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')]),
  'an unpaired surrogate in UTF-16': Buffer.concat([Buffer.from('{"a":"', 'utf16le'), Buffer.from([0x00, 0xd8]), Buffer.from('"}', 'utf16le')]),
  'a truncated UTF-32 character': utf32(json, 'LE').subarray(0, -1),
  'text after the document, which Jackson ignores': Buffer.from(`${json} trailing`),
  'a second document, which Jackson ignores': Buffer.from(`${json}{"eventsExpiration":0}`),
  'a second byte-order mark': withMark([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], Buffer.from(json)),
  'no JSON at all': Buffer.from('credentials=Chosen-1'),
  'nothing': Buffer.alloc(0),
};

for (const [name, bytes] of Object.entries(unreadable)) {
  test(`a body with ${name} is not read`, () => {
    assert.throws(() => readJsonBytes(bytes));
  });
}
