import { catalogFor } from '../catalog/index.js';
import { buildRequest } from '../http/request.js';
import { frozenJsonCopy } from '../internal/json.js';
import { irreversibleBodyRules, isIrreversible, isMutation } from '../policy/classify.js';
import { REALM_CREATION } from '../policy/table.js';
import { checkCompensation, explainBodyRules } from './compensation-rules.js';

// Preflight applies its rules in a fixed order and reports the first that fails, so the order
// of the lists below decides which message a plan with several problems gets.

function requireStepCount(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('workflow requires 1 to 20 steps');
}

function requireWritesForMutations(config, steps, operationCatalog) {
  if (!config.allowWrite && steps.some(step => isMutation(step.operation, operationCatalog))) throw new Error('writes are disabled');
}

function requireOperation({ step, label }) {
  if (!step || typeof step.operation !== 'string') throw new Error(`${label} has no operation`);
}

function requirePinnedRealmCreation({ config, step, label }) {
  if (step.operation !== REALM_CREATION.operation) return;
  const body = step.args?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body[REALM_CREATION.bodyField] !== config.realm)
    throw new Error(`${label} realm creation must name the configured realm`);
  if (step.compensate?.operation !== REALM_CREATION.compensation) throw new Error(`${label} realm creation must compensate by deleting that realm`);
}

function requireBuildableRequest({ config, step, operationCatalog }) {
  buildRequest(config, step.operation, step.args, operationCatalog);
}

function refuseIrreversibleMark({ step, label }) {
  if (step.irreversible === true) throw new Error(`${label} is read-only and cannot be marked irreversible`);
}

function refuseCompensation({ step, label }) {
  if (step.compensate) throw new Error(`${label} is read-only and needs no compensation`);
}

function requireIrreversibleOverride({ config, step, label, irreversible, bodyRules }) {
  if (irreversible && !(config.allowIrreversible && step.irreversible === true))
    throw new Error(`${label} is irreversible and requires an explicit override${bodyRules.length ? `: ${explainBodyRules(bodyRules)}` : ''}`);
}

function requireCompensation({ step, label, irreversible }) {
  if (!irreversible && !step.compensate?.operation) throw new Error(`${label} needs an explicit compensation`);
}

function checkDeclaredCompensation(context) {
  if (context.step.compensate?.operation) checkCompensation(context);
}

function requireWriteLock({ config }) {
  if (!config.lockDatabaseUrl && !config.singleWriter) throw new Error('writes require a PostgreSQL lock or explicit single-writer mode');
}

const stepRules = [requirePinnedRealmCreation, requireBuildableRequest];
const readRules = [refuseIrreversibleMark, refuseCompensation];
const mutationRules = [requireIrreversibleOverride, requireCompensation, checkDeclaredCompensation, requireWriteLock];

function planStep(context) {
  for (const rule of stepRules) rule(context);
  const { config, step, operationCatalog } = context;
  const mutation = isMutation(step.operation, operationCatalog);
  const bodyRules = mutation ? irreversibleBodyRules(step.operation, step.args, config, operationCatalog) : [];
  const irreversible = isIrreversible(step.operation, operationCatalog) || bodyRules.length > 0 || step.irreversible === true;
  for (const rule of mutation ? mutationRules : readRules) rule({ ...context, irreversible, bodyRules });
  return Object.freeze({ operation: step.operation, args: step.args ?? Object.freeze({}), compensate: step.compensate ?? null, irreversible });
}

// Validates a whole plan without network access and returns it normalized. Without a catalog it
// uses the one the configuration selects. The rules run on a frozen copy of the steps, and the plan
// is built from that copy, so a caller that changes its step objects later cannot change what runs.
export function preflight(config, steps, operationCatalog = catalogFor(config)) {
  requireStepCount(steps);
  const contexts = frozenJsonCopy(steps).map((step, index) => ({ config, operationCatalog, step, label: `step ${index + 1}` }));
  contexts.forEach(requireOperation);
  requireWritesForMutations(config, steps, operationCatalog);
  return contexts.map(planStep);
}
