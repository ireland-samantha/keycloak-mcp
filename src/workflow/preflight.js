import { isDeepStrictEqual } from 'node:util';
import { describeOperation } from '../catalog/index.js';
import { buildRequest } from '../http/request.js';
import { directChildParameter } from '../internal/path-template.js';
import { isIrreversible, isMutation, namedCreateTarget } from '../policy/classify.js';
import { REALM_CREATION } from '../policy/table.js';
import { idBindings, isIdMarker, withPendingIds } from './markers.js';

export function preflight(config, steps, operationCatalog) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('workflow requires 1 to 20 steps');
  if (!config.allowWrite && steps.some(step => isMutation(step.operation, operationCatalog))) throw new Error('writes are disabled');
  return steps.map((step, index) => {
    if (!step || typeof step.operation !== 'string') throw new Error(`step ${index + 1} has no operation`);
    if (step.operation === REALM_CREATION.operation) {
      if (!step.args?.body || typeof step.args.body !== 'object' || Array.isArray(step.args.body) ||
        step.args.body[REALM_CREATION.bodyField] !== config.realm)
        throw new Error(`step ${index + 1} realm creation must name the configured realm`);
      if (step.compensate?.operation !== REALM_CREATION.compensation)
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
        const childParameter = directChildParameter(collection, compensation.path);
        const childValue = step.compensate.args?.path?.[childParameter];
        const bound = idBindings(step.compensate.args);
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
          /id|uuid/i.test(childParameter) && !isIdMarker(childValue))
          throw new Error(`step ${index + 1} created-resource compensation needs a generated-ID binding`);
        if (['PUT', 'PATCH'].includes(source.method) &&
          (!['PUT', 'PATCH'].includes(compensation.method) || compensation.path !== source.path ||
            !isDeepStrictEqual(step.compensate.args?.path ?? {}, step.args?.path ?? {}) ||
            !isDeepStrictEqual(step.compensate.args?.query ?? {}, step.args?.query ?? {})))
          throw new Error(`step ${index + 1} update compensation must target the same resource`);
        const matchingRealmCreation = step.operation === REALM_CREATION.operation &&
          step.compensate.operation === REALM_CREATION.compensation;
        const namedTarget = namedCreateTarget(step.operation);
        const matchingNamedCreation = namedTarget && compensation.method === 'DELETE' &&
          childParameter === namedTarget.child && typeof childValue === 'string' &&
          childValue.trim().length > 0 && childValue === step.args?.body?.[namedTarget.field];
        if (isIrreversible(step.compensate.operation, operationCatalog) &&
          !matchingRealmCreation && !matchingNamedCreation && !(childParameter && isIdMarker(childValue)))
          throw new Error(`step ${index + 1} cannot use an irreversible compensation without a generated-ID or matching created-name binding`);
        buildRequest(config, step.compensate.operation, withPendingIds(step.compensate.args), operationCatalog);
        if (!isMutation(step.compensate.operation, operationCatalog)) throw new Error(`step ${index + 1} compensation must mutate`);
      }
      if (!config.lockDatabaseUrl && !config.singleWriter) throw new Error('writes require a PostgreSQL lock or explicit single-writer mode');
    } else if (step.compensate) throw new Error(`step ${index + 1} is read-only and needs no compensation`);
    return { operation: step.operation, args: step.args ?? {}, compensate: step.compensate ?? null, irreversible };
  });
}
