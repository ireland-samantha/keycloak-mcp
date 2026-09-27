import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildRequest, describeOperation, isMutation, isIrreversible } from './keycloak.js';

const held = new Set();
const locationMarker = '$step.locationId';
const responseIdMarker = '$step.responseId';
const idMarkers = new Set([locationMarker, responseIdMarker]);
const namedCreateTargets = new Map([
  ['POST /admin/realms/{realm}/roles', { child: 'role-name', field: 'name' }],
  ['POST /admin/realms/{realm}/identity-provider/instances', { child: 'alias', field: 'alias' }],
]);
const generatedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sensitivePathName = /secret|token|password|credential/i;

function receiptPath(args = {}) {
  return Object.fromEntries(Object.entries(args.path ?? {}).map(([name, value]) => [name, sensitivePathName.test(name) ? '[REDACTED]' : String(value)]));
}

function compensationArgsForValidation(compensate) {
  const path = Object.fromEntries(Object.entries(compensate.args?.path ?? {}).map(([name, value]) => [name, idMarkers.has(value) ? 'created-id-pending' : value]));
  return { ...compensate.args, path };
}

function locationId(config, operationCatalog, step, result) {
  if (!result.location) throw new Error('create succeeded without a Location for compensation');
  const created = new URL(result.location, config.baseUrl);
  const request = buildRequest(config, step.operation, step.args, operationCatalog);
  if (created.origin !== new URL(request.url).origin || created.username || created.password)
    throw new Error('create Location is outside the configured Keycloak origin');
  const prefix = new URL(request.url).pathname.replace(/\/$/, '') + '/';
  if (!created.pathname.startsWith(prefix) || created.search || created.hash) throw new Error('create Location does not identify a child of the requested collection');
  const tail = created.pathname.slice(prefix.length);
  if (!tail || tail.includes('/')) throw new Error('create Location has no single resource ID');
  return decodeURIComponent(tail);
}

function resolveCompensation(config, operationCatalog, step, result) {
  const compensate = step.compensate;
  if (!compensate) return null;
  const bindings = Object.entries(compensate.args?.path ?? {}).filter(([, value]) => idMarkers.has(value));
  if (!bindings.length) return compensate;
  const [name, marker] = bindings[0];
  let id;
  if (marker === locationMarker) id = locationId(config, operationCatalog, step, result);
  else {
    const value = result.value;
    const ids = [value?.id, value?._id].filter(item => item !== undefined);
    if (!value || typeof value !== 'object' || Array.isArray(value) || ids.length === 0 ||
      ids.some(item => typeof item !== 'string' || !generatedUuid.test(item)) || new Set(ids).size !== 1)
      throw new Error('create response has no unambiguous generated UUID for compensation');
    id = ids[0];
    if (result.location && locationId(config, operationCatalog, step, result) !== id)
      throw new Error('create response ID disagrees with Location');
  }
  const path = { ...compensate.args?.path, [name]: id };
  const resolved = { operation: compensate.operation, args: { ...compensate.args, path } };
  buildRequest(config, resolved.operation, resolved.args, operationCatalog);
  return resolved;
}

async function acquireLocal(key) {
  if (held.has(key)) throw new Error('a workflow already holds this realm in this process');
  held.add(key);
  return { assertHeld: async () => {}, release: async () => { held.delete(key); } };
}

async function acquirePostgres(connectionString, key) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  const signedKey = createHash('sha256').update(key).digest().readBigInt64BE().toString();
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [signedKey]);
    if (!result.rows[0].acquired) throw new Error('another workflow holds this realm');
    return {
      assertHeld: async () => { await client.query('SELECT 1'); },
      release: async () => {
        try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [signedKey]); }
        finally { await client.end(); }
      },
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}

function journalWriter(config, plan) {
  const directory = config.journalDir || join(homedir(), '.local', 'state', 'keycloak-mcp');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error('journal directory must be private (mode 0700)');
  const id = randomUUID();
  const file = join(directory, `${id}.json`);
  return {
    id,
    write(record) {
      const temporary = `${file}.tmp`;
      const fd = openSync(temporary, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ runId: id, at: new Date().toISOString(), realm: config.realm,
          plan: plan.map(step => ({ operation: step.operation, path: receiptPath(step.args),
            compensation: step.compensate?.operation ?? null, compensationPath: receiptPath(step.compensate?.args) })), ...record }, null, 2) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, file);
    },
  };
}

export function preflight(config, steps, operationCatalog) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('workflow requires 1 to 20 steps');
  if (!config.allowWrite && steps.some(step => isMutation(step.operation, operationCatalog))) throw new Error('writes are disabled');
  return steps.map((step, index) => {
    if (!step || typeof step.operation !== 'string') throw new Error(`step ${index + 1} has no operation`);
    if (step.operation === 'POST /admin/realms') {
      if (!step.args?.body || typeof step.args.body !== 'object' || Array.isArray(step.args.body) ||
        step.args.body.realm !== config.realm)
        throw new Error(`step ${index + 1} realm creation must name the configured realm`);
      if (step.compensate?.operation !== 'DELETE /admin/realms/{realm}')
        throw new Error(`step ${index + 1} realm creation must compensate by deleting that realm`);
    }
    buildRequest(config, step.operation, step.args, operationCatalog);
    const mutation = isMutation(step.operation, operationCatalog);
    const irreversible = isIrreversible(step.operation, operationCatalog) || step.irreversible === true;
    if (!mutation && step.irreversible === true) throw new Error(`step ${index + 1} is read-only and cannot be marked irreversible`);
    if (mutation) {
      if (irreversible && !(config.allowIrreversible && step.irreversible === true)) throw new Error(`step ${index + 1} is irreversible and requires an explicit override`);
      if (!irreversible && !step.compensate?.operation) throw new Error(`step ${index + 1} needs an explicit compensation`);
      if (step.compensate?.operation) {
        const source = describeOperation(step.operation, operationCatalog);
        const compensation = describeOperation(step.compensate.operation, operationCatalog);
        const collection = source.path.replace(/\/$/, '');
        const childParameter = compensation.path.startsWith(`${collection}/`)
          ? /^\{([^/{}]+)\}$/.exec(compensation.path.slice(collection.length + 1))?.[1] : null;
        const childValue = step.compensate.args?.path?.[childParameter];
        const bound = Object.entries(step.compensate.args?.path ?? {}).filter(([, value]) => idMarkers.has(value));
        if (source.method === 'POST' && compensation.method !== 'DELETE')
          throw new Error(`step ${index + 1} compensation must delete the created resource`);
        if (source.method === 'POST' && childParameter) {
          const parentPath = Object.fromEntries(Object.entries(step.compensate.args?.path ?? {})
            .filter(([name]) => name !== childParameter));
          if (!isDeepStrictEqual(parentPath, step.args?.path ?? {}))
            throw new Error(`step ${index + 1} created resource compensation must target the same parent`);
        }
        if (bound.length > 1 || (bound.length && !step.operation.startsWith('POST '))) throw new Error(`step ${index + 1} has an invalid Location binding`);
        if (bound.length) {
          if (compensation.method !== 'DELETE' || compensation.path !== `${collection}/{${bound[0][0]}}`)
            throw new Error(`step ${index + 1} compensation must target the created resource`);
        }
        if (source.method === 'POST' && compensation.method === 'DELETE' &&
          compensation.path !== source.path && !childParameter)
          throw new Error(`step ${index + 1} compensation must target the created resource`);
        if (source.method === 'POST' && compensation.method === 'DELETE' && childParameter &&
          /id|uuid/i.test(childParameter) && !idMarkers.has(childValue))
          throw new Error(`step ${index + 1} created-resource compensation needs a generated-ID binding`);
        if (['PUT', 'PATCH'].includes(source.method) &&
          (!['PUT', 'PATCH'].includes(compensation.method) || compensation.path !== source.path ||
            !isDeepStrictEqual(step.compensate.args?.path ?? {}, step.args?.path ?? {}) ||
            !isDeepStrictEqual(step.compensate.args?.query ?? {}, step.args?.query ?? {})))
          throw new Error(`step ${index + 1} update compensation must target the same resource`);
        const matchingRealmCreation = step.operation === 'POST /admin/realms' &&
          step.compensate.operation === 'DELETE /admin/realms/{realm}';
        const namedTarget = namedCreateTargets.get(step.operation);
        const matchingNamedCreation = namedTarget && compensation.method === 'DELETE' &&
          childParameter === namedTarget.child && typeof childValue === 'string' &&
          childValue.trim().length > 0 && childValue === step.args?.body?.[namedTarget.field];
        if (isIrreversible(step.compensate.operation, operationCatalog) &&
          !matchingRealmCreation && !matchingNamedCreation && !(childParameter && idMarkers.has(childValue)))
          throw new Error(`step ${index + 1} cannot use an irreversible compensation without a generated-ID or matching created-name binding`);
        buildRequest(config, step.compensate.operation, compensationArgsForValidation(step.compensate), operationCatalog);
        if (!isMutation(step.compensate.operation, operationCatalog)) throw new Error(`step ${index + 1} compensation must mutate`);
      }
      if (!config.lockDatabaseUrl && !config.singleWriter) throw new Error('writes require a PostgreSQL lock or explicit single-writer mode');
    } else if (step.compensate) throw new Error(`step ${index + 1} is read-only and needs no compensation`);
    return { operation: step.operation, args: step.args ?? {}, compensate: step.compensate ?? null, irreversible };
  });
}

export async function runWorkflow(admin, steps, { dryRun = true } = {}) {
  const plan = preflight(admin.config, steps, admin.catalog);
  if (dryRun) return { status: 'PREFLIGHT_OK', steps: plan.map(step => ({ operation: step.operation, compensation: step.compensate?.operation ?? null })) };
  const key = `${admin.config.baseUrl}|${admin.config.realm}`;
  const lock = admin.config.lockDatabaseUrl ? await acquirePostgres(admin.config.lockDatabaseUrl, key) : await acquireLocal(key);
  const completed = [];
  const receiptCompleted = () => completed.map(item => ({ operation: item.step.operation, path: receiptPath(item.step.args),
    status: item.status, compensation: item.compensate?.operation ?? null, compensationPath: receiptPath(item.compensate?.args) }));
  try {
    const journal = journalWriter(admin.config, plan);
    journal.write({ status: 'RUNNING', completed: [], next: plan[0].operation });
    for (const step of plan) {
      try {
        await lock.assertHeld();
        journal.write({ status: 'STEP_IN_FLIGHT', completed: receiptCompleted(), next: step.operation, nextPath: receiptPath(step.args) });
        const result = await admin._invoke(step.operation, step.args);
        const compensate = resolveCompensation(admin.config, admin.catalog, step, result);
        completed.push({ step, compensate, status: result.status });
        journal.write({ status: 'RUNNING', completed: receiptCompleted() });
      } catch (error) {
        const rollback = [];
        journal.write({ status: 'COMPENSATING', failedOperation: step.operation, failedPath: receiptPath(step.args), completed: receiptCompleted() });
        for (const done of [...completed].reverse()) {
          if (!done.compensate) continue;
          try {
            await lock.assertHeld();
            // A new realm adds its admin roles after the create response. A
            // token minted before creation may lack permission to delete it.
            if (done.step.operation === 'POST /admin/realms' &&
              done.compensate.operation === 'DELETE /admin/realms/{realm}') admin.invalidateToken();
            const result = await admin._invoke(done.compensate.operation, done.compensate.args);
            rollback.push({ operation: done.compensate.operation, path: receiptPath(done.compensate.args), status: result.status, outcome: 'COMPENSATED' });
          } catch (compensationError) {
            rollback.push({ operation: done.compensate.operation, path: receiptPath(done.compensate.args), outcome: 'FAILED', error: String(compensationError.message) });
          }
          journal.write({ status: 'COMPENSATING', failedOperation: step.operation, failedPath: receiptPath(step.args), completed: receiptCompleted(), rollback });
        }
        // A failed mutation response does not prove the server skipped the write.
        // Earlier compensation also needs readback before restoration is claimed.
        const status = 'IN_DOUBT';
        const failedStepMayHaveCommitted = isMutation(step.operation, admin.catalog);
        journal.write({ status, failedOperation: step.operation, failedPath: receiptPath(step.args), completed: receiptCompleted(), failedStepMayHaveCommitted, priorStepsCompensated: !rollback.some(item => item.outcome === 'FAILED') && !completed.some(item => item.step.irreversible), rollback });
        return { runId: journal.id, status, failedOperation: step.operation, error: String(error.message), failedStepMayHaveCommitted, priorStepsCompensated: !rollback.some(item => item.outcome === 'FAILED') && !completed.some(item => item.step.irreversible), rollback, completed: completed.map(item => ({ operation: item.step.operation, status: item.status })) };
      }
    }
    journal.write({ status: 'COMPLETED', completed: receiptCompleted() });
    return { runId: journal.id, status: 'COMPLETED', completed: completed.map(item => ({ operation: item.step.operation, status: item.status })) };
  } finally {
    await lock.release();
  }
}

export class WorkflowBuilder {
  constructor(admin) { this.admin = admin; this.steps = []; }
  step(operation, args = {}, compensation = null) {
    this.steps.push({ operation, args, ...(compensation ? { compensate: compensation } : {}) });
    return this;
  }
  plan() { return runWorkflow(this.admin, this.steps, { dryRun: true }); }
  run() { return runWorkflow(this.admin, this.steps, { dryRun: false }); }
}
