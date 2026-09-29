import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = ([, value]) => value !== undefined;

// Objects are written one key per line down to `depth`; anything deeper is one compact JSON line,
// so a behaviour change shows up as a small line diff in review.
export function formatSnapshot(value, depth, indent = '') {
  if (depth === 0 || !isObject(value)) return JSON.stringify(value);
  const entries = Object.entries(value).filter(present);
  if (!entries.length) return '{}';
  const inner = `${indent} `;
  const lines = entries.map(([key, child]) => `${inner}${JSON.stringify(key)}: ${formatSnapshot(child, depth - 1, inner)}`);
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

function rows(value, depth, path = []) {
  if (depth === 0 || !isObject(value)) return [[path.join(' › '), JSON.stringify(value)]];
  return Object.entries(value).filter(present).flatMap(([key, child]) => rows(child, depth - 1, [...path, key]));
}

function firstDifference(expected = '', actual = '') {
  let index = 0;
  while (index < expected.length && expected[index] === actual[index]) index += 1;
  const excerpt = text => JSON.stringify(text.slice(Math.max(0, index - 60), index + 100));
  return `\n    expected …${excerpt(expected)}\n    actual   …${excerpt(actual)}`;
}

function describeDrift(expectedText, actual, depth) {
  const expected = new Map(rows(JSON.parse(expectedText), depth));
  const observed = new Map(rows(actual, depth));
  const changed = [];
  for (const [path, json] of observed) {
    if (!expected.has(path)) changed.push(`added ${path}`);
    else if (expected.get(path) !== json) changed.push(`changed ${path}${firstDifference(expected.get(path), json)}`);
  }
  for (const path of expected.keys()) if (!observed.has(path)) changed.push(`removed ${path}`);
  if (!changed.length) changed.push('rows are equal but their order or formatting differs');
  return `${changed.length} snapshot row(s) differ:\n  ${changed.slice(0, 12).join('\n  ')}`;
}

// Compares `value` with the committed snapshot file; UPDATE_GOLDEN=1 rewrites the file instead.
export function assertSnapshot(file, value, { depth }) {
  const text = `${formatSnapshot(value, depth)}\n`;
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(file, text);
    return;
  }
  const expectedText = readFileSync(file, 'utf8');
  if (text === expectedText) return;
  assert.fail(`${describeDrift(expectedText, value, depth)}\nIf the change is intended, rerun with UPDATE_GOLDEN=1 and review the snapshot diff.`);
}
