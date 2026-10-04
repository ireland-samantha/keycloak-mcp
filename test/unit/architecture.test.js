import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { posix, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Layers from the bottom up; a module may import from its own layer and from the layers listed
// for it, which all sit below it. Paths are relative to the repository root.
const layers = [
  ['internal', 'src/internal/', []],
  ['config', 'src/config.js', ['internal']],
  ['meta', 'src/meta.js', []],
  ['catalog', 'src/catalog/', ['internal']],
  ['policy', 'src/policy/', ['internal', 'catalog']],
  ['http', 'src/http/', ['internal', 'config', 'catalog', 'policy']],
  ['keycloak-admin', 'src/keycloak-admin.js', ['internal', 'catalog', 'policy', 'http']],
  // The workflow reaches Keycloak only through the admin object it is handed.
  ['workflow', 'src/workflow/', ['internal', 'catalog', 'policy', 'http']],
  ['tools', 'src/tools/', ['catalog', 'workflow']],
  ['adapters', 'src/adapters/', ['meta', 'config', 'keycloak-admin', 'tools']],
  ['api', 'src/api.js', ['config', 'catalog', 'keycloak-admin', 'workflow']],
  ['bin', 'src/index.js', ['config', 'keycloak-admin', 'adapters']],
  ['openclaw-entry', 'openclaw/index.js', ['adapters']],
];
const packages = { tools: ['zod'], adapters: ['@modelcontextprotocol/server'], workflow: ['pg'] };

const layerOf = file => layers.find(([, prefix]) => file === prefix || (prefix.endsWith('/') && file.startsWith(prefix)))?.[0];
const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

// Static imports and re-exports, bare imports and dynamic import() of a string literal.
function specifiers(source) {
  const patterns = [/(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g];
  return patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]));
}

const files = [...readdirSync(`${root}src`, { recursive: true }).map(name => `src/${name.split(sep).join('/')}`), 'openclaw/index.js']
  .filter(file => file.endsWith('.js')).sort();
const imports = new Map(files.map(file => [file, specifiers(readFileSync(`${root}${file}`, 'utf8')).map(specifier =>
  specifier.startsWith('.') ? { file: posix.normalize(posix.join(posix.dirname(file), specifier)) } : { specifier })]));

test('every module belongs to a layer and the import parser sees the dependency graph', () => {
  assert.deepEqual(files.filter(file => !layerOf(file)), []);
  const edges = [...imports.values()].flat().filter(target => target.file);
  assert.ok(edges.length > 50, `${edges.length} module imports`);
  assert.ok(imports.get('src/policy/classify.js').some(target => target.file === 'src/policy/table.js'), 'multi-line import is parsed');
  assert.ok(imports.get('src/workflow/locks.js').some(target => target.specifier === 'pg'), 'dynamic import is parsed');
});

test('modules import only downward: allowed layers, node builtins and their own packages', () => {
  const allowed = new Map(layers.map(([name, , below]) => [name, new Set([name, ...below])]));
  const violations = [];
  for (const [file, targets] of imports) {
    const layer = layerOf(file);
    for (const target of targets) {
      if (target.file) {
        if (!files.includes(target.file)) violations.push(`${file} imports missing ${target.file}`);
        else if (!allowed.get(layer).has(layerOf(target.file))) violations.push(`${file} (${layer}) imports ${target.file} (${layerOf(target.file)})`);
      } else if (!target.specifier.startsWith('node:') && !(packages[layer] ?? []).includes(packageName(target.specifier))) {
        violations.push(`${file} (${layer}) imports package ${target.specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the allowed layers only point down the layer order', () => {
  const rank = new Map(layers.map(([name], index) => [name, index]));
  for (const [name, , below] of layers) for (const target of below) assert.ok(rank.get(target) < rank.get(name), `${name} -> ${target}`);
});

test('the module graph has no import cycles', () => {
  const state = new Map();
  const visit = (file, path) => {
    if (state.get(file) === 'done') return;
    assert.notEqual(state.get(file), 'open', `cycle: ${[...path, file].join(' -> ')}`);
    state.set(file, 'open');
    for (const target of imports.get(file)) if (target.file) visit(target.file, [...path, file]);
    state.set(file, 'done');
  };
  for (const file of files) visit(file, []);
});
