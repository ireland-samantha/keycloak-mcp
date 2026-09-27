import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Installs the packed extension into a throwaway OpenClaw home, then calls its tools through a
// loopback Gateway against a disposable realm. The bootstrap administrator only creates and
// deletes that realm and its service account; the plugin sees only its private configPath file.
if (process.env.KEYCLOAK_MCP_LIVE_OPENCLAW !== 'true') throw new Error('set KEYCLOAK_MCP_LIVE_OPENCLAW=true to run against a disposable loopback Keycloak');
for (const name of ['KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP', 'KEYCLOAK_MCP_OPENCLAW_OUT'])
  if (!process.env[name]) throw new Error(`${name} is required`);
const bootstrapFile = process.env.KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP;
if ((statSync(bootstrapFile).mode & 0o077) !== 0) throw new Error('KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP must be a private file (mode 0600)');
const bootstrap = JSON.parse(readFileSync(bootstrapFile, 'utf8'));
const base = new URL(bootstrap.baseUrl);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('refusing a non-loopback Keycloak: this run creates and deletes a realm');
const baseUrl = base.href.replace(/\/$/, '');
const out = process.env.KEYCLOAK_MCP_OPENCLAW_OUT;
const openclawBin = process.env.KEYCLOAK_MCP_OPENCLAW_BIN || 'openclaw';
const root = fileURLToPath(new URL('..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = path => (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
const tools = ['keycloak_search_operations', 'keycloak_describe_operation', 'keycloak_describe_schema', 'keycloak_read', 'keycloak_workflow'];

const openclawDir = dirname(realpathSync(openclawBin.includes('/') ? openclawBin
  : process.env.PATH.split(delimiter).map(dir => join(dir, openclawBin)).find(existsSync)));
function openclawPackage() {
  const { name, version } = JSON.parse(readFileSync(join(openclawDir, 'package.json'), 'utf8'));
  const lock = join(openclawDir, '..', '..', 'package-lock.json');
  const integrity = existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')).packages?.['node_modules/openclaw']?.integrity ?? null : null;
  return { name, version, integrity };
}
// OpenClaw's own outcome grader, from its public plugin SDK, judges every tool result below.
const sdk = JSON.parse(readFileSync(join(openclawDir, 'package.json'), 'utf8')).exports['./plugin-sdk/agent-harness-runtime'].default;
const { isToolResultError } = await import(pathToFileURL(join(openclawDir, sdk)).href);

const work = mkdtempSync(join(tmpdir(), 'keycloak-mcp-openclaw-'));
chmodSync(work, 0o700);
const home = join(work, 'home');
const journal = join(work, 'journal');
mkdirSync(home);
mkdirSync(journal, { mode: 0o700 });
// No KEYCLOAK_* variable reaches OpenClaw, so the plugin can only use its configPath file.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KEYCLOAK_')));
Object.assign(env, { OPENCLAW_HOME: home, OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_NO_PROMPT: '1', OPENCLAW_NO_ONBOARD: '1' });
const cli = (...args) => spawnSync(openclawBin, args, { env, encoding: 'utf8', timeout: 600_000 });
const cliJson = (...args) => {
  const run = cli(...args, '--json');
  assert.equal(run.status, 0, `openclaw ${args.join(' ')}: ${run.stderr}`);
  return JSON.parse(run.stdout);
};

async function kc(method, path, body) {
  const token = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, { method: 'POST', redirect: 'error',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: bootstrap.username, password: bootstrap.password }) });
  assert.equal(token.status, 200, 'bootstrap administrator token');
  const response = await fetch(`${baseUrl}${path}`, { method, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${(await token.json()).access_token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { status: response.status, location: response.headers.get('location'), value };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const gatewayToken = randomBytes(24).toString('base64url');
const clientSecret = randomBytes(24).toString('base64url');
async function startGateway() {
  const port = await freePort();
  const child = spawn(openclawBin, ['gateway', 'run', '--bind', 'loopback', '--port', String(port), '--auth', 'token'],
    { env: { ...env, OPENCLAW_GATEWAY_TOKEN: gatewayToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-20_000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-20_000); });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    await exited;
    clearTimeout(timer);
    return true;
  };
  const invoke = async (tool, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, ok: body?.ok ?? null, details: body?.result?.details ?? null,
      gradedError: body?.ok === true ? isToolResultError(body.result) : null,
      text: body?.result?.content?.[0]?.text ?? body?.error?.message ?? null };
  };
  // Serve the first tool, or give the listener 15 seconds before recording what it answers.
  const deadline = Date.now() + 180_000;
  let answeredAt = null;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`gateway exited ${child.exitCode}: ${log.slice(-4000)}`);
    const probe = await invoke(tools[0], { search: 'serverinfo', limit: 1 }).catch(() => null);
    if (probe && probe.httpStatus !== 503) answeredAt ??= Date.now();
    if (probe?.httpStatus === 200 || (answeredAt && Date.now() - answeredAt > 15_000)) return { invoke, stop, probe };
    if (Date.now() > deadline) { await stop(); throw new Error(`gateway not ready: ${log.slice(-4000)}`); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const suffix = randomBytes(4).toString('hex');
const realm = `keycloak-mcp-openclaw-${suffix}`;
const groupName = `keycloak-mcp-openclaw-group-${suffix}`;
const evidence = [];
const record = (step, observed) => { evidence.push({ id: `E${evidence.length + 1}`, step, ...observed }); return observed; };
const gateways = [];
const report = { observedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}` };
let failure = null;
let cleanup = null;
try {
  report.openclaw = { ...openclawPackage(), cli: cli('--version').stdout.trim() };
  report.keycloakVersion = (await kc('GET', '/admin/serverinfo')).value.systemInfo.version;
  report.sourceSha256 = Object.fromEntries(['openclaw/index.js', 'openclaw.plugin.json', 'src/keycloak.js', 'src/workflow.js']
    .map(path => [path, sha256(readFileSync(join(root, path)))]));
  const catalog = JSON.parse(readFileSync(join(root, 'data/operations.json'), 'utf8'));
  report.catalog = { version: 'latest', sourceSha256: catalog.sourceSha256 };

  assert.equal((await kc('POST', '/admin/realms', { realm, enabled: true })).status, 201);
  const client = await kc('POST', `/admin/realms/${realm}/clients`, { clientId: 'keycloak-mcp-openclaw', enabled: true,
    protocol: 'openid-connect', publicClient: false, serviceAccountsEnabled: true, standardFlowEnabled: false,
    directAccessGrantsEnabled: false, clientAuthenticatorType: 'client-secret', secret: clientSecret });
  assert.equal(client.status, 201);
  const clientUuid = client.location.split('/').pop();
  const serviceUser = (await kc('GET', `/admin/realms/${realm}/clients/${clientUuid}/service-account-user`)).value;
  const management = (await kc('GET', `/admin/realms/${realm}/clients?clientId=realm-management`)).value[0];
  const realmAdmin = (await kc('GET', `/admin/realms/${realm}/clients/${management.id}/roles/realm-admin`)).value;
  assert.equal((await kc('POST', `/admin/realms/${realm}/users/${serviceUser.id}/role-mappings/clients/${management.id}`, [realmAdmin])).status, 204);
  const account = { KEYCLOAK_BASE_URL: baseUrl, KEYCLOAK_REALM: realm, KEYCLOAK_AUTH_REALM: realm, KEYCLOAK_CLIENT_ID: 'keycloak-mcp-openclaw',
    KEYCLOAK_CLIENT_SECRET: clientSecret, KEYCLOAK_MCP_CATALOG_VERSION: 'latest' };
  const readConfig = join(work, 'read-only.json');
  const writeConfig = join(work, 'write.json');
  writeFileSync(readConfig, JSON.stringify({ ...account, KEYCLOAK_MCP_ALLOW_WRITE: 'false' }), { mode: 0o600 });
  writeFileSync(writeConfig, JSON.stringify({ ...account, KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true',
    KEYCLOAK_MCP_JOURNAL_DIR: journal }), { mode: 0o600 });

  const packDir = join(work, 'pack');
  mkdirSync(packDir);
  const pack = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const [packed] = JSON.parse(pack.stdout);
  const tarball = join(packDir, packed.filename);
  report.packed = { filename: packed.filename, entryCount: packed.entryCount, integrity: packed.integrity, sha256: sha256(readFileSync(tarball)) };

  const install = cli('plugins', 'install', `npm-pack:${tarball}`, '--force', '--accept-capabilities');
  record('install', { command: 'openclaw plugins install npm-pack:<packed tarball> --force --accept-capabilities', exitCode: install.status,
    installed: /Installed plugin: keycloak-mcp/.test(install.stdout) });
  assert.equal(install.status, 0, install.stderr);
  const metadata = cliJson('plugins', 'inspect', 'keycloak-mcp');
  record('metadata', { command: 'openclaw plugins inspect keycloak-mcp --json', imported: metadata.plugin.imported,
    contractTools: metadata.plugin.contracts?.tools ?? [], consentedTools: metadata.install?.acceptedSurface?.tools ?? [],
    diagnostics: metadata.diagnostics.length });
  const names = inspected => inspected.tools.flatMap(tool => tool.names ?? [tool.name ?? tool]);
  const unconfigured = cliJson('plugins', 'inspect', 'keycloak-mcp', '--runtime');
  record('unconfigured', { command: 'openclaw plugins inspect keycloak-mcp --runtime --json (no configPath)', status: unconfigured.plugin.status,
    tools: names(unconfigured), diagnostics: unconfigured.diagnostics.map(item => item.message) });
  assert.equal(cli('config', 'set', 'plugins.entries.keycloak-mcp.config.configPath', readConfig).status, 0);
  const runtime = cliJson('plugins', 'inspect', 'keycloak-mcp', '--runtime');
  record('runtime', { command: 'openclaw plugins inspect keycloak-mcp --runtime --json (0600 configPath)', configMode: mode(readConfig),
    keycloakVariablesPassed: Object.keys(env).filter(key => key.startsWith('KEYCLOAK_')).length,
    status: runtime.plugin.status, imported: runtime.plugin.imported, tools: names(runtime), diagnostics: runtime.diagnostics.length,
    diagnosticMessages: [...new Set(runtime.diagnostics.map(item => item.message.slice(0, 200)))] });
  const doctor = cli('plugins', 'doctor', '--json');
  const doctorReport = JSON.parse(doctor.stdout || 'null');
  record('doctor', { command: 'openclaw plugins doctor --json', exitCode: doctor.status, ok: doctorReport?.ok ?? null,
    pluginErrors: doctorReport?.pluginErrors?.length ?? null, diagnostics: doctorReport?.diagnostics?.length ?? null,
    configurationWarnings: doctorReport?.configurationWarnings?.length ?? null });

  assert.equal(cli('config', 'set', 'gateway.mode', 'local').status, 0);
  const exact = { operation: 'GET /admin/realms/{realm}/groups', args: { query: { search: groupName, exact: true } } };
  const total = { operation: 'GET /admin/realms/{realm}/groups/count' };
  const plan = [
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: groupName } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
    { operation: 'GET /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': randomUUID() } } },
  ];
  const summary = call => ({ httpStatus: call.httpStatus, ok: call.ok, gradedError: call.gradedError, detailsStatus: call.details?.status ?? null,
    ...(call.text?.startsWith('Error:') ? { text: call.text.slice(0, 160) } : {}) });
  const count = call => (Array.isArray(call.details?.value) ? call.details.value.length : null);
  const groups = call => call.details?.value?.count ?? null;

  const reader = await startGateway();
  gateways.push(reader);
  const search = await reader.invoke('keycloak_search_operations', { search: 'groups', method: 'GET', limit: 5 });
  record('gateway-search', { tool: 'keycloak_search_operations', ...summary(search), total: search.details?.total ?? null });
  const describe = await reader.invoke('keycloak_describe_operation', { operation: 'GET /admin/realms/{realm}/groups' });
  record('gateway-describe', { tool: 'keycloak_describe_operation', ...summary(describe), key: describe.details?.key ?? null });
  const schema = await reader.invoke('keycloak_describe_schema', { name: 'GroupRepresentation' });
  record('gateway-schema', { tool: 'keycloak_describe_schema', ...summary(schema), hasProperties: Boolean(schema.details?.schema?.properties) });
  const realmRead = await reader.invoke('keycloak_read', { operation: 'GET /admin/realms/{realm}' });
  record('gateway-read', { tool: 'keycloak_read', operation: 'GET /admin/realms/{realm}', ...summary(realmRead),
    realmMatches: realmRead.details?.value?.realm === realm });
  const before = await reader.invoke('keycloak_read', exact);
  const refused = await reader.invoke('keycloak_read', { operation: plan[0].operation, args: plan[0].args });
  record('gateway-read-refuses-mutation', { tool: 'keycloak_read', operation: plan[0].operation, ...summary(refused) });
  const preflight = await reader.invoke('keycloak_workflow', { steps: plan });
  record('gateway-preflight-read-only', { tool: 'keycloak_workflow', execute: false, config: 'KEYCLOAK_MCP_ALLOW_WRITE=false', ...summary(preflight) });
  const disabled = await reader.invoke('keycloak_workflow', { steps: plan, execute: true });
  record('gateway-execute-read-only', { tool: 'keycloak_workflow', execute: true, config: 'KEYCLOAK_MCP_ALLOW_WRITE=false', ...summary(disabled) });
  const after = await reader.invoke('keycloak_read', exact);
  record('gateway-read-only-count', { tool: 'keycloak_read', operation: exact.operation, ...summary(after),
    exactNameCountBefore: count(before), exactNameCountAfter: count(after) });
  await reader.stop();

  assert.equal(cli('config', 'set', 'plugins.entries.keycloak-mcp.config.configPath', writeConfig).status, 0);
  const writer = await startGateway();
  gateways.push(writer);
  const writeConfigName = 'KEYCLOAK_MCP_ALLOW_WRITE=true, KEYCLOAK_MCP_SINGLE_WRITER=true';
  const writePreflight = await writer.invoke('keycloak_workflow', { steps: plan });
  record('gateway-preflight-write', { tool: 'keycloak_workflow', execute: false, config: writeConfigName, ...summary(writePreflight) });
  const writeBefore = await writer.invoke('keycloak_read', exact);
  const totalBefore = await writer.invoke('keycloak_read', total);
  const cycle = await writer.invoke('keycloak_workflow', { steps: plan, execute: true });
  const writeAfter = await writer.invoke('keycloak_read', exact);
  const totalAfter = await writer.invoke('keycloak_read', total);
  const receipts = readdirSync(journal);
  record('gateway-compensated-write', { tool: 'keycloak_workflow', execute: true, config: writeConfigName, ...summary(cycle),
    createStatus: cycle.details?.completed?.[0]?.status ?? null, forcedReadFailure: Number(cycle.details?.error?.match(/HTTP (\d+)/)?.[1]) || null,
    rollbackStatus: cycle.details?.rollback?.[0]?.status ?? null, failedStepMayHaveCommitted: cycle.details?.failedStepMayHaveCommitted ?? null,
    priorStepsCompensated: cycle.details?.priorStepsCompensated ?? null, exactNameCountBefore: count(writeBefore),
    exactNameCountAfter: count(writeAfter), groupCountBefore: groups(totalBefore), groupCountAfter: groups(totalAfter), journalDirMode: mode(journal), receiptModes: [...new Set(receipts.map(file => mode(join(journal, file))))] });
  await writer.stop();
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 2000) : String(error);
} finally {
  const stopped = [];
  for (const gateway of gateways) stopped.push(await gateway.stop());
  const removed = await kc('DELETE', `/admin/realms/${realm}`).catch(() => ({ status: null }));
  const absent = await kc('GET', `/admin/realms/${realm}`).catch(() => ({ status: null }));
  rmSync(work, { recursive: true, force: true });
  cleanup = { gatewaysStopped: stopped.length === gateways.length && stopped.every(Boolean), realmDelete: removed.status,
    realmAbsentRead: absent.status, workDirRemoved: !existsSync(work) };
}

// Each requirement is a decidable predicate over recorded evidence; a missing record is NOT_RUN.
const step = Object.fromEntries(evidence.map(item => [item.step, item]));
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const sameSet = (actual, expected) => same([...(actual ?? [])].sort(), [...expected].sort());
const served = call => call?.httpStatus === 200 && call.ok === true;
const requirements = [
  ['REQ-1', 'OpenClaw installs the packed tarball after source confirmation and capability consent', ['install'],
    e => e.install.exitCode === 0 && e.install.installed],
  ['REQ-2', 'Before importing plugin code, OpenClaw reads the five tools from the manifest and the consent record covers them', ['metadata'],
    e => e.metadata.imported === false && same(e.metadata.contractTools, tools) && sameSet(e.metadata.consentedTools, tools)],
  ['REQ-3', 'Without a config file, registration fails with a diagnostic and registers no tools', ['unconfigured'],
    e => e.unconfigured.status === 'error' && e.unconfigured.tools.length === 0 && e.unconfigured.diagnostics.length > 0],
  ['REQ-4', 'With a 0600 configPath and no KEYCLOAK_* variables, the runtime loads the five tools and doctor passes', ['runtime', 'doctor'],
    e => e.runtime.status === 'loaded' && e.runtime.imported === true && same(e.runtime.tools, tools) && e.runtime.diagnostics === 0 &&
      e.runtime.configMode === '0600' && e.runtime.keycloakVariablesPassed === 0 && e.doctor.ok === true && e.doctor.pluginErrors === 0],
  ['REQ-5', 'The Gateway serves every tool, and a live read returns the configured realm, each graded successful', ['gateway-search', 'gateway-describe', 'gateway-schema', 'gateway-read'],
    e => ['gateway-search', 'gateway-describe', 'gateway-schema', 'gateway-read'].every(key => served(e[key]) && e[key].gradedError === false) &&
      e['gateway-search'].total > 0 && e['gateway-describe'].key === 'GET /admin/realms/{realm}/groups' && e['gateway-schema'].hasProperties &&
      e['gateway-read'].detailsStatus === 200 && e['gateway-read'].realmMatches === true],
  ['REQ-6', 'Refused calls reach OpenClaw as failed results and write nothing', ['gateway-read-refuses-mutation', 'gateway-preflight-read-only', 'gateway-execute-read-only', 'gateway-read-only-count'],
    e => ['gateway-read-refuses-mutation', 'gateway-preflight-read-only', 'gateway-execute-read-only'].every(key => served(e[key]) && e[key].gradedError === true) &&
      e['gateway-read-only-count'].exactNameCountBefore === 0 && e['gateway-read-only-count'].exactNameCountAfter === 0],
  ['REQ-7', 'With writes enabled, a compensated create through the Gateway is rolled back, graded failed, and leaves no group', ['gateway-preflight-write', 'gateway-compensated-write'],
    e => served(e['gateway-preflight-write']) && e['gateway-preflight-write'].detailsStatus === 'PREFLIGHT_OK' && e['gateway-preflight-write'].gradedError === false &&
      served(e['gateway-compensated-write']) && e['gateway-compensated-write'].detailsStatus === 'IN_DOUBT' && e['gateway-compensated-write'].gradedError === true &&
      e['gateway-compensated-write'].createStatus === 201 && e['gateway-compensated-write'].forcedReadFailure === 404 &&
      e['gateway-compensated-write'].rollbackStatus === 204 && e['gateway-compensated-write'].failedStepMayHaveCommitted === false &&
      e['gateway-compensated-write'].priorStepsCompensated === true && e['gateway-compensated-write'].exactNameCountBefore === 0 &&
      e['gateway-compensated-write'].exactNameCountAfter === 0 && e['gateway-compensated-write'].groupCountBefore === 0 &&
      e['gateway-compensated-write'].groupCountAfter === 0 && e['gateway-compensated-write'].journalDirMode === '0700' &&
      same(e['gateway-compensated-write'].receiptModes, ['0600'])],
  ['REQ-8', 'The disposable realm, Gateways, and throwaway OpenClaw home are gone afterward', [],
    () => cleanup.gatewaysStopped && cleanup.realmDelete === 204 && cleanup.realmAbsentRead === 404 && cleanup.workDirRemoved],
].map(([id, predicate, steps, holds]) => {
  const cited = steps.map(key => step[key]?.id ?? null);
  let status = 'NOT_RUN';
  if (cited.every(Boolean)) { try { status = holds(step) ? 'PROVEN' : 'CONTRADICTED'; } catch { status = 'CONTRADICTED'; } }
  return { id, predicate, evidence: cited.length ? cited : ['cleanup'], status };
});
const harness = { script: 'scripts/live-openclaw.mjs', sha256: sha256(readFileSync(fileURLToPath(import.meta.url))) };
const scope = 'One run of the packed tarball through upstream OpenClaw in a throwaway home: install, metadata and runtime inspection, doctor, and ' +
  'Gateway /tools/invoke calls against a realm created for the run on a loopback Keycloak. Tool outcomes are graded by OpenClaw\'s public isToolResultError.';
const limit = 'No model-driven agent turn ran; the Gateway direct-invoke endpoint called the tools. The service account held realm-admin in a disposable ' +
  'realm on a development server. This does not cover other OpenClaw releases, production networking or containers, the PostgreSQL lock, or other ' +
  'operations. Report-level admission against the signed review pack was not run.';
// Local paths and generated secrets never enter the receipt.
let receipt = JSON.stringify({ ...report, harness, scope, limit, evidence, cleanup, requirements, admission: 'NOT_RUN', ...(failure ? { failure } : {}) }, null, 2);
for (const [value, marker] of [[work, '<work>'], [root.replace(/\/$/, ''), '<repo>'], [gatewayToken, '<token>'], [clientSecret, '<secret>'], [bootstrap.password, '<secret>']])
  receipt = receipt.replaceAll(value, marker);
writeFileSync(out, `${receipt}\n`);
if (failure) throw new Error(failure);
const open = requirements.filter(item => item.status !== 'PROVEN');
if (open.length) throw new Error(`requirements not proven: ${open.map(item => `${item.id} ${item.status}`).join(', ')}`);
console.log(JSON.stringify({ realm, evidence: evidence.length, requirements: requirements.length, cleanup }));
