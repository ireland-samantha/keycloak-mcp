import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { toolNames, tools } from '../../src/tools/registry.js';

// OpenClaw reads contracts.tools and toolMetadata before importing plugin code, so the manifest must match the registry.
test('the OpenClaw manifest lists the registry tools in order, replay-safe exactly when read-only', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, toolNames);
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.toolMetadata).map(([name, metadata]) => [name, metadata.replaySafe])),
    Object.fromEntries(tools.map(tool => [tool.name, tool.readOnly])));
});
