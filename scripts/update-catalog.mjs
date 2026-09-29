import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { operationParameters } from '../src/catalog/corrections.js';
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
for (const [version, suffix] of [['latest', ''], ['26.3.5', '-26.3.5'], ['nightly', '-nightly']]) {
  const source = `https://www.keycloak.org/docs-api/${version}/rest-api/openapi.json`;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`catalog download failed: ${source} HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const spec = JSON.parse(bytes.toString('utf8'));
  await writeFile(new URL(`../data/openapi${suffix}.json`, import.meta.url), JSON.stringify(spec) + '\n');
  const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).filter(([method]) => methods.has(method)).map(([method, op]) => ({
    key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path,
    summary: op.summary ?? '', description: op.description ?? '', tags: op.tags ?? [],
    parameters: operationParameters(path, item, op).filter(p => p.name && p.in).map(p => ({ name: p.name, in: p.in, required: p.required ?? false, type: p.schema?.type ?? 'string' })),
    requestTypes: Object.keys(op.requestBody?.content ?? {}),
    responseTypes: [...new Set(Object.values(op.responses ?? {}).flatMap(r => Object.keys(r.content ?? {})))].sort(),
  })));
  operations.sort((a, b) => a.key.localeCompare(b.key));
  await writeFile(new URL(`../data/operations${suffix}.json`, import.meta.url), JSON.stringify({ source, sourceSha256: createHash('sha256').update(bytes).digest('hex'), operations }) + '\n');
  console.log(`${operations.length} operations from ${source}`);
}
