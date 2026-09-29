import { isDeepStrictEqual } from 'node:util';
import { describeOperation } from '../catalog/index.js';
import { buildRequest } from '../http/request.js';
import { directChildParameter } from '../internal/path-template.js';
import { isGeneratedIdParameter, isIrreversible, isMutation, namedCreateTarget } from '../policy/classify.js';
import { REALM_CREATION } from '../policy/table.js';
import { idBindings, isIdMarker, withPendingIds } from './markers.js';

const UPDATE_METHODS = ['PUT', 'PATCH'];
// Methods whose compensation the rules below give a shape: creates, updates and deletes.
const CHECKABLE_METHODS = ['POST', ...UPDATE_METHODS, 'DELETE'];

const fail = (context, message) => { throw new Error(`${context.label} ${message}`); };

// What the rules compare: both operations, the collection the step addresses, and the compensation
// path parameter naming a direct child of that collection, if there is one.
function compensationTarget({ step, operationCatalog }) {
  const source = describeOperation(step.operation, operationCatalog);
  const compensation = describeOperation(step.compensate.operation, operationCatalog);
  const collection = source.path.replace(/\/$/, '');
  const childParameter = directChildParameter(collection, compensation.path);
  return { source, compensation, collection, childParameter,
    childValue: step.compensate.args?.path?.[childParameter], bindings: idBindings(step.compensate.args) };
}

// A mutation by another method, such as an extension GET declared reversible, would otherwise pass
// with any mutating compensation, however unrelated.
function compensationCheckable({ source }, context) {
  if (!CHECKABLE_METHODS.includes(source.method)) fail(context, `is a ${source.method} mutation whose compensation preflight cannot check; mark it irreversible instead`);
}

const deletesAfterCreate = ({ source, compensation }) => source.method === 'POST' && compensation.method === 'DELETE';

function createUndoneByDelete({ source, compensation }, context) {
  if (source.method === 'POST' && compensation.method !== 'DELETE') fail(context, 'compensation must delete the created resource');
}

function createdChildKeepsParent({ source, childParameter }, context) {
  if (source.method !== 'POST' || !childParameter) return;
  const { step } = context;
  const parentPath = Object.fromEntries(Object.entries(step.compensate.args?.path ?? {}).filter(([name]) => name !== childParameter));
  if (!isDeepStrictEqual(parentPath, step.args?.path ?? {})) fail(context, 'created resource compensation must target the same parent');
}

function singleBindingOnCreate({ bindings }, context) {
  if (bindings.length > 1 || (bindings.length && !context.step.operation.startsWith('POST '))) fail(context, 'has an invalid Location binding');
}

function bindingDeletesCreatedChild({ bindings, compensation, collection }, context) {
  if (bindings.length && (compensation.method !== 'DELETE' || compensation.path !== `${collection}/{${bindings[0][0]}}`))
    fail(context, 'compensation must target the created resource');
}

function deleteTargetsCreatedResource(target, context) {
  if (deletesAfterCreate(target) && target.compensation.path !== target.source.path && !target.childParameter)
    fail(context, 'compensation must target the created resource');
}

function generatedIdNeedsBinding(target, context) {
  if (deletesAfterCreate(target) && target.childParameter && isGeneratedIdParameter(target.childParameter) && !isIdMarker(target.childValue))
    fail(context, 'created-resource compensation needs a generated-ID binding');
}

function updateRestoresSameResource({ source, compensation }, context) {
  const { step } = context;
  if (UPDATE_METHODS.includes(source.method) &&
    (!UPDATE_METHODS.includes(compensation.method) || compensation.path !== source.path ||
      !isDeepStrictEqual(step.compensate.args?.path ?? {}, step.args?.path ?? {}) ||
      !isDeepStrictEqual(step.compensate.args?.query ?? {}, step.args?.query ?? {})))
    fail(context, 'update compensation must target the same resource');
}

const deletesCreatedRealm = ({ step }) => step.operation === REALM_CREATION.operation && step.compensate.operation === REALM_CREATION.compensation;

function deletesCreatedName({ compensation, childParameter, childValue }, { step }) {
  const named = namedCreateTarget(step.operation);
  return Boolean(named) && compensation.method === 'DELETE' && childParameter === named.child && typeof childValue === 'string' &&
    childValue.trim().length > 0 && childValue === step.args?.body?.[named.field];
}

// An irreversible compensation (a DELETE, say) may only remove what this step itself created.
function irreversibleUndoesOnlyTheCreate(target, context) {
  if (isIrreversible(context.step.compensate.operation, context.operationCatalog) && !deletesCreatedRealm(context) &&
    !deletesCreatedName(target, context) && !(target.childParameter && isIdMarker(target.childValue)))
    fail(context, 'cannot use an irreversible compensation without a generated-ID or matching created-name binding');
}

function compensationBuilds(_target, { config, step, operationCatalog }) {
  buildRequest(config, step.compensate.operation, withPendingIds(step.compensate.args), operationCatalog);
}

function compensationMutates(_target, context) {
  if (!isMutation(context.step.compensate.operation, context.operationCatalog)) fail(context, 'compensation must mutate');
}

// Applied in this order; the first failing rule's message is the one reported.
const rules = [
  compensationCheckable, createUndoneByDelete, createdChildKeepsParent, singleBindingOnCreate, bindingDeletesCreatedChild,
  deleteTargetsCreatedResource, generatedIdNeedsBinding, updateRestoresSameResource, irreversibleUndoesOnlyTheCreate,
  compensationBuilds, compensationMutates,
];

// context: { config, operationCatalog, step, label } for a mutating step that declares a compensation.
export function checkCompensation(context) {
  const target = compensationTarget(context);
  for (const rule of rules) rule(target, context);
}
