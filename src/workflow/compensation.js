import { buildRequest } from '../http/request.js';
import { idBindings, LOCATION_ID } from './markers.js';

const GENERATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The last segment of the create response's Location, which must name a direct child of the
// collection the step posted to, on the configured origin.
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

// The generated UUID in the create response's JSON `id` or `_id`, which must agree with any Location.
function responseId(config, operationCatalog, step, result) {
  const value = result.value;
  const ids = [value?.id, value?._id].filter(item => item !== undefined);
  if (!value || typeof value !== 'object' || Array.isArray(value) || ids.length === 0 ||
    ids.some(item => typeof item !== 'string' || !GENERATED_UUID.test(item)) || new Set(ids).size !== 1)
    throw new Error('create response has no unambiguous generated UUID for compensation');
  const [id] = ids;
  if (result.location && locationId(config, operationCatalog, step, result) !== id)
    throw new Error('create response ID disagrees with Location');
  return id;
}

// The step's compensation with its ID marker, if any, replaced by the ID the step's result returned,
// and that ID as `created`: { parameter, id }, the path parameter it fills and its value.
export function resolveCompensation(config, operationCatalog, step, result) {
  const compensate = step.compensate;
  const bindings = idBindings(compensate?.args);
  if (!bindings.length) return { compensate, created: null };
  const [parameter, marker] = bindings[0];
  const id = marker === LOCATION_ID ? locationId(config, operationCatalog, step, result) : responseId(config, operationCatalog, step, result);
  const resolved = { operation: compensate.operation, args: { ...compensate.args, path: { ...compensate.args?.path, [parameter]: id } } };
  buildRequest(config, resolved.operation, resolved.args, operationCatalog);
  return { compensate: resolved, created: { parameter, id } };
}
