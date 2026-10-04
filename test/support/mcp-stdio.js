import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpSession } from './mcp-client.js';
import { privateTempDir, writePrivateJson } from './temp.js';

const entryPoint = fileURLToPath(new URL('../../src/index.js', import.meta.url));

// Spawns `node src/index.js` with a clean environment: PATH, a private HOME, and KEYCLOAK_MCP_CONFIG
// naming a config file (mode `configMode`) that holds the KEYCLOAK_* `settings`.
export function spawnStdioServer({ settings = {}, home = privateTempDir('keycloak-mcp-home-'), configMode = 0o600 } = {}) {
  const configFile = writePrivateJson(join(home, 'config.json'), settings);
  chmodSync(configFile, configMode);
  const child = spawn(process.execPath, [entryPoint], {
    cwd: home, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, KEYCLOAK_MCP_CONFIG: configFile },
  });
  const server = {
    child, home, configFile, stderr: '', stdoutNoise: [],
    session: new McpSession(message => new Promise((resolve, reject) =>
      child.stdin.write(`${JSON.stringify(message)}\n`, error => (error ? reject(error) : resolve())))),
    exited: once(child, 'exit').then(([code, signal]) => ({ code, signal })),
    async close({ timeoutMs = 5000 } = {}) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      try { return await server.exited; } finally { clearTimeout(timer); }
    },
  };
  server.exited.then(({ code, signal }) => server.session.abort(new Error(`server exited (code ${code}, signal ${signal})`)));
  child.stderr.setEncoding('utf8').on('data', chunk => { server.stderr += chunk; });
  let buffered = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      try { server.session.receive(JSON.parse(line)); } catch { server.stdoutNoise.push(line); }
    }
  });
  child.stdin.on('error', () => { /* the exit status reports a server that stopped reading */ });
  return server;
}
