import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, tools } from './openclaw-requirements.mjs';

// Installs the packed extension into a throwaway OpenClaw home, then calls its tools through a
// loopback Gateway against a disposable realm. The bootstrap administrator reads the server
// version, creates the realm, its service account and a control group, and deletes the realm;
// the plugin sees only its private configPath file.
if (process.env.KEYCLOAK_MCP_LIVE_OPENCLAW !== 'true') throw new Error('set KEYCLOAK_MCP_LIVE_OPENCLAW=true to run against a disposable loopback Keycloak');
for (const name of ['KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP', 'KEYCLOAK_MCP_OPENCLAW_OUT'])
  if (!process.env[name]) throw new Error(`${name} is required`);
const bootstrapFile = process.env.KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP;
if ((statSync(bootstrapFile).mode & 0o077) !== 0) throw new Error('KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP must be a private file (mode 0600)');
const bootstrap = JSON.parse(readFileSync(bootstrapFile, 'utf8'));
// A short password can occur in ordinary receipt text, which would withhold the receipt after a full run.
if (typeof bootstrap.password !== 'string' || bootstrap.password.length < 16)
  throw new Error('use a bootstrap administrator password of at least 16 random characters');
const base = new URL(bootstrap.baseUrl);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('refusing a non-loopback Keycloak: this run creates and deletes a realm');
const baseUrl = base.href.replace(/\/$/, '');
const out = process.env.KEYCLOAK_MCP_OPENCLAW_OUT;
const openclawBin = process.env.KEYCLOAK_MCP_OPENCLAW_BIN || 'openclaw';
const root = fileURLToPath(new URL('..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = path => (statSync(path).mode & 0o777).toString(8).padStart(4, '0');

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
const state = join(home, '.openclaw');
const journal = join(work, 'journal');
mkdirSync(state, { recursive: true });
// OpenClaw logs into the throwaway directory from its first command.
writeFileSync(join(state, 'openclaw.json'), `${JSON.stringify({ logging: { file: join(work, 'openclaw.log') } }, null, 2)}\n`);
// Inherited OPENCLAW_* paths outrank OPENCLAW_HOME and KEYCLOAK_* would configure the plugin, so neither passes through.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KEYCLOAK_') && !key.startsWith('OPENCLAW_')));
Object.assign(env, { OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'),
  OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_NO_PROMPT: '1', OPENCLAW_NO_ONBOARD: '1' });
// A signal only marks the run interrupted and aborts in-flight Gateway calls. The run stops before its next
// command, request, or Gateway, cleans up once, and writes no receipt.
let interrupted = null;
const aborter = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted ??= signal; aborter.abort(); });
const halt = () => { if (interrupted) throw new Error(`interrupted by ${interrupted}`); };
const cli = (...args) => { halt(); return spawnSync(openclawBin, args, { env, encoding: 'utf8', timeout: 600_000 }); };
const cliJson = (...args) => {
  const run = cli(...args, '--json');
  assert.equal(run.status, 0, `openclaw ${args.join(' ')}: ${run.stderr}`);
  return JSON.parse(run.stdout);
};

async function kc(method, path, body, { cleanup = false } = {}) {
  if (!cleanup) halt();
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

const suffix = randomBytes(4).toString('hex');
const realm = `keycloak-mcp-openclaw-${suffix}`;
const groupName = `${realm}-group`;
const controlName = `${realm}-control`;
const gatewayToken = randomBytes(24).toString('base64url');
const clientSecret = randomBytes(24).toString('base64url');
const gateways = [];
let realmCreation = null;

async function startGateway() {
  const port = await freePort();
  halt();
  const child = spawn(openclawBin, ['gateway', 'run', '--bind', 'loopback', '--port', String(port), '--auth', 'token'],
    { env: { ...env, OPENCLAW_GATEWAY_TOKEN: gatewayToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-20_000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-20_000); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let forced = false;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 20_000);
    const exit = await exited;
    clearTimeout(timer);
    return { ...exit, forced };
  };
  const invoke = async (tool, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: 'POST', redirect: 'error', signal: aborter.signal,
      headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, ok: body?.ok ?? null, details: body?.result?.details ?? null,
      gradedError: body?.ok === true ? isToolResultError(body.result) : null,
      text: body?.result?.content?.[0]?.text ?? body?.error?.message ?? null };
  };
  const gateway = { invoke, stop };
  gateways.push(gateway);
  // Serve the first tool, or give the listener 15 seconds before recording what it answers.
  const deadline = Date.now() + 180_000;
  let answeredAt = null;
  for (;;) {
    halt();
    if (child.exitCode !== null) throw new Error(`gateway exited ${child.exitCode}: ${log.slice(-4000)}`);
    const probe = await invoke(tools[0], { search: 'serverinfo', limit: 1 }).catch(() => null);
    if (probe && probe.httpStatus !== 503) answeredAt ??= Date.now();
    if (probe?.httpStatus === 200 || (answeredAt && Date.now() - answeredAt > 15_000)) return gateway;
    if (Date.now() > deadline) throw new Error(`gateway not ready: ${log.slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function cleanUp() {
  const exits = [];
  for (const gateway of gateways) exits.push(await gateway.stop());
  // Only a realm this run created is deleted, once its creation request has settled.
  const creation = realmCreation ? await realmCreation.catch(() => null) : null;
  const removed = creation?.status === 201
    ? await kc('DELETE', `/admin/realms/${realm}`, undefined, { cleanup: true }).catch(() => ({ status: null })) : { status: null };
  const absent = await kc('GET', `/admin/realms/${realm}`, undefined, { cleanup: true }).catch(() => ({ status: null }));
  rmSync(work, { recursive: true, force: true });
  return { gatewaysExited: exits.every(exit => !exit.forced), realmDelete: removed.status, realmAbsentRead: absent.status,
    workDirRemoved: !existsSync(work) };
}

const evidence = [];
const record = (step, observed) => { evidence.push({ id: `E${evidence.length + 1}`, step, ...observed }); };
const report = { observedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}` };
let failure = null;
try {
  report.openclaw = { ...openclawPackage(), cli: cli('--version').stdout.trim() };
  report.keycloakVersion = (await kc('GET', '/admin/serverinfo')).value.systemInfo.version;
  report.sourceSha256 = Object.fromEntries(['openclaw/index.js', 'openclaw.plugin.json', 'package.json', 'src/keycloak.js', 'src/workflow.js',
    'data/operations.json', 'data/openapi.json', 'data/operations-26.3.5.json', 'data/openapi-26.3.5.json']
    .map(path => [path, sha256(readFileSync(join(root, path)))]));
  const catalog = JSON.parse(readFileSync(join(root, 'data/operations.json'), 'utf8'));
  report.catalog = { version: 'latest', sourceSha256: catalog.sourceSha256 };

  realmCreation = kc('POST', '/admin/realms', { realm, enabled: true });
  assert.equal((await realmCreation).status, 201);
  const client = await kc('POST', `/admin/realms/${realm}/clients`, { clientId: 'keycloak-mcp-openclaw', enabled: true,
    protocol: 'openid-connect', publicClient: false, serviceAccountsEnabled: true, standardFlowEnabled: false,
    directAccessGrantsEnabled: false, clientAuthenticatorType: 'client-secret', secret: clientSecret });
  assert.equal(client.status, 201);
  const clientUuid = client.location.split('/').pop();
  const serviceUser = (await kc('GET', `/admin/realms/${realm}/clients/${clientUuid}/service-account-user`)).value;
  const management = (await kc('GET', `/admin/realms/${realm}/clients?clientId=realm-management`)).value[0];
  const realmAdmin = (await kc('GET', `/admin/realms/${realm}/clients/${management.id}/roles/realm-admin`)).value;
  assert.equal((await kc('POST', `/admin/realms/${realm}/users/${serviceUser.id}/role-mappings/clients/${management.id}`, [realmAdmin])).status, 204);
  // A control group shows that the exact-name query can find a group, so its zero counts mean absence.
  assert.equal((await kc('POST', `/admin/realms/${realm}/groups`, { name: controlName })).status, 201);
  const account = { KEYCLOAK_BASE_URL: baseUrl, KEYCLOAK_REALM: realm, KEYCLOAK_AUTH_REALM: realm, KEYCLOAK_CLIENT_ID: 'keycloak-mcp-openclaw',
    KEYCLOAK_CLIENT_SECRET: clientSecret, KEYCLOAK_MCP_CATALOG_VERSION: 'latest' };
  const readConfig = join(work, 'read-only.json');
  const writeConfig = join(work, 'write.json');
  writeFileSync(readConfig, JSON.stringify({ ...account, KEYCLOAK_MCP_ALLOW_WRITE: 'false' }), { mode: 0o600 });
  writeFileSync(writeConfig, JSON.stringify({ ...account, KEYCLOAK_MCP_ALLOW_WRITE: 'true', KEYCLOAK_MCP_SINGLE_WRITER: 'true',
    KEYCLOAK_MCP_JOURNAL_DIR: journal }), { mode: 0o600 });

  const packDir = join(work, 'pack');
  mkdirSync(packDir);
  halt();
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
    installedUnderThrowawayHome: existsSync(metadata.install?.installPath ?? '') &&
      realpathSync(metadata.install.installPath).startsWith(`${realpathSync(home)}${sep}`),
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
  const exact = name => ({ operation: 'GET /admin/realms/{realm}/groups', args: { query: { search: name, exact: true } } });
  const total = { operation: 'GET /admin/realms/{realm}/groups/count' };
  const plan = [
    { operation: 'POST /admin/realms/{realm}/groups', args: { body: { name: groupName } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': '$step.locationId' } } } },
    { operation: 'GET /admin/realms/{realm}/groups/{group-id}', args: { path: { 'group-id': randomUUID() } } },
  ];
  const summary = call => ({ httpStatus: call.httpStatus, ok: call.ok, gradedError: call.gradedError, detailsStatus: call.details?.status ?? null,
    ...(call.text?.startsWith('Error:') ? { text: call.text.slice(0, 160) } : {}),
    ...(call.httpStatus !== 200 ? { error: call.text?.slice(0, 160) ?? null } : {}) });
  const count = call => (Array.isArray(call.details?.value) ? call.details.value.length : null);
  const groups = call => call.details?.value?.count ?? null;

  const reader = await startGateway();
  const search = await reader.invoke('keycloak_search_operations', { search: 'groups', method: 'GET', limit: 5 });
  record('gateway-search', { tool: 'keycloak_search_operations', ...summary(search), total: search.details?.total ?? null });
  const describe = await reader.invoke('keycloak_describe_operation', { operation: 'GET /admin/realms/{realm}/groups' });
  record('gateway-describe', { tool: 'keycloak_describe_operation', ...summary(describe), key: describe.details?.key ?? null });
  const schema = await reader.invoke('keycloak_describe_schema', { name: 'GroupRepresentation' });
  record('gateway-schema', { tool: 'keycloak_describe_schema', ...summary(schema), hasProperties: Boolean(schema.details?.schema?.properties) });
  const realmRead = await reader.invoke('keycloak_read', { operation: 'GET /admin/realms/{realm}' });
  record('gateway-read', { tool: 'keycloak_read', operation: 'GET /admin/realms/{realm}', ...summary(realmRead),
    realmMatches: realmRead.details?.value?.realm === realm });
  const before = await reader.invoke('keycloak_read', exact(groupName));
  const control = await reader.invoke('keycloak_read', exact(controlName));
  const refused = await reader.invoke('keycloak_read', { operation: plan[0].operation, args: plan[0].args });
  record('gateway-read-refuses-mutation', { tool: 'keycloak_read', operation: plan[0].operation, ...summary(refused) });
  const preflight = await reader.invoke('keycloak_workflow', { steps: plan });
  record('gateway-preflight-read-only', { tool: 'keycloak_workflow', execute: false, config: 'KEYCLOAK_MCP_ALLOW_WRITE=false', ...summary(preflight) });
  const disabled = await reader.invoke('keycloak_workflow', { steps: plan, execute: true });
  record('gateway-execute-read-only', { tool: 'keycloak_workflow', execute: true, config: 'KEYCLOAK_MCP_ALLOW_WRITE=false', ...summary(disabled) });
  const after = await reader.invoke('keycloak_read', exact(groupName));
  record('gateway-read-only-count', { tool: 'keycloak_read', operation: 'GET /admin/realms/{realm}/groups', ...summary(after),
    controlExactNameCount: count(control), exactNameCountBefore: count(before), exactNameCountAfter: count(after) });
  await reader.stop();

  assert.equal(cli('config', 'set', 'plugins.entries.keycloak-mcp.config.configPath', writeConfig).status, 0);
  const writer = await startGateway();
  const writeConfigName = 'KEYCLOAK_MCP_ALLOW_WRITE=true, KEYCLOAK_MCP_SINGLE_WRITER=true';
  const writePreflight = await writer.invoke('keycloak_workflow', { steps: plan });
  record('gateway-preflight-write', { tool: 'keycloak_workflow', execute: false, config: writeConfigName, ...summary(writePreflight) });
  const writeBefore = await writer.invoke('keycloak_read', exact(groupName));
  const totalBefore = await writer.invoke('keycloak_read', total);
  const cycle = await writer.invoke('keycloak_workflow', { steps: plan, execute: true });
  const writeAfter = await writer.invoke('keycloak_read', exact(groupName));
  const totalAfter = await writer.invoke('keycloak_read', total);
  const receipts = existsSync(journal) ? readdirSync(journal) : [];
  record('gateway-compensated-write', { tool: 'keycloak_workflow', execute: true, config: writeConfigName, ...summary(cycle),
    createStatus: cycle.details?.completed?.[0]?.status ?? null, forcedReadFailure: Number(cycle.details?.error?.match(/HTTP (\d+)/)?.[1]) || null,
    rollbackStatus: cycle.details?.rollback?.[0]?.status ?? null, failedStepMayHaveCommitted: cycle.details?.failedStepMayHaveCommitted ?? null,
    priorStepsCompensated: cycle.details?.priorStepsCompensated ?? null, exactNameCountBefore: count(writeBefore),
    exactNameCountAfter: count(writeAfter), groupCountBefore: groups(totalBefore), groupCountAfter: groups(totalAfter),
    journalDirMode: existsSync(journal) ? mode(journal) : null, receiptModes: [...new Set(receipts.map(file => mode(join(journal, file))))] });
  await writer.stop();
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 2000) : String(error);
}
const cleanup = await cleanUp();
if (interrupted) {
  console.error(`interrupted by ${interrupted}; no receipt written; cleanup ${JSON.stringify(cleanup)}`);
  process.exit(interrupted === 'SIGINT' ? 130 : 143);
}

const requirements = evaluate(evidence, cleanup);
const harness = Object.fromEntries(['scripts/live-openclaw.mjs', 'scripts/openclaw-requirements.mjs']
  .map(path => [path, sha256(readFileSync(join(root, path)))]));
const scope = 'One run of the packed tarball through upstream OpenClaw with its home, state, config, and log in a throwaway directory: install, ' +
  'metadata and runtime inspection, doctor, and Gateway /tools/invoke calls against a realm created for the run on a loopback Keycloak. ' +
  'The harness grades each Gateway result with OpenClaw\'s public isToolResultError.';
const limit = 'No model-driven agent turn ran; the Gateway direct-invoke endpoint called the tools. The service account held realm-admin in a ' +
  'disposable realm on a development server. OpenClaw lock files under the system temporary directory are not removed. This does not cover ' +
  'other OpenClaw releases, production networking or containers, the PostgreSQL lock, or other operations. No external report schema ' +
  'reviewed this receipt (admission NOT_RUN).';
// Local paths are replaced by name. A secret is never rewritten in place: if one occurs, no receipt is written.
let receipt = JSON.stringify({ ...report, harness, scope, limit, evidence, cleanup, requirements, admission: 'NOT_RUN',
  ...(failure ? { failure } : {}) }, null, 2);
for (const [path, marker] of [[work, '<work>'], [root.replace(/\/$/, ''), '<repo>'], [openclawDir, '<openclaw>']])
  receipt = receipt.replaceAll(path, marker);
// Check the raw and JSON-escaped forms, since the receipt text is JSON.
if ([gatewayToken, clientSecret, bootstrap.password].some(secret => receipt.includes(secret) || receipt.includes(JSON.stringify(secret).slice(1, -1))))
  throw new Error(`a secret occurs in the receipt text, so no receipt was written${failure ? '; the run had also failed' : ''}`);
writeFileSync(out, `${receipt}\n`);
if (failure) throw new Error(failure);
const open = requirements.filter(item => item.status !== 'PROVEN');
if (open.length) throw new Error(`requirements not proven: ${open.map(item => `${item.id} ${item.status}`).join(', ')}`);
console.log(JSON.stringify({ realm, evidence: evidence.length, requirements: requirements.length, cleanup }));
