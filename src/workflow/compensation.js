import { randomUUID } from 'node:crypto';
import { buildRequest } from '../http/request.js';
import { namedCreateTarget, upsertIdField } from '../policy/classify.js';
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

// The args a step is sent with. A create Keycloak may answer with an existing object gets a new ID in
// its body when its compensation binds the created ID, so Keycloak either creates exactly that object or
// refuses the step; `chosenId` is that ID.
export function argsToSend(step) {
  const idField = upsertIdField(step.operation);
  if (!idField || !idBindings(step.compensate?.args).length) return { args: step.args, chosenId: null };
  const chosenId = randomUUID();
  return { args: { ...step.args, body: { ...step.args.body, [idField]: chosenId } }, chosenId };
}

// The step's compensation with its ID marker, if any, replaced by the ID the step's result returned,
// and that ID as `created`: { parameter, id }, the path parameter it fills and its value. When
// keycloak-mcp chose the ID (`chosenId`), the result must name exactly that object.
export function resolveCompensation(config, operationCatalog, step, result, chosenId = null) {
  const compensate = step.compensate;
  const bindings = idBindings(compensate?.args);
  if (!bindings.length) return { compensate, created: null };
  const [parameter, marker] = bindings[0];
  const id = marker === LOCATION_ID ? locationId(config, operationCatalog, step, result) : responseId(config, operationCatalog, step, result);
  if (chosenId && id !== chosenId) throw new Error('create response names another object than the one this step created');
  const resolved = { operation: compensate.operation, args: { ...compensate.args, path: { ...compensate.args?.path, [parameter]: id } } };
  buildRequest(config, resolved.operation, resolved.args, operationCatalog);
  return { compensate: resolved, created: { parameter, id } };
}

// For a create of a named child (see NAMED_CREATE_TARGETS), reads the child by the name its
// compensation deletes to learn its immutable ID. Returns the compensation by that ID where Keycloak
// has a route for it, else the compensation by name with the ID to recheck (`verify`) before it runs;
// null for any other create.
export async function pinToCreatedId(admin, step, compensate) {
  const named = namedCreateTarget(step.operation);
  if (!named || !compensate) return null;
  const lookup = { operation: named.lookup, args: { path: { ...step.args.path, [named.child]: compensate.args.path[named.child] } } };
  const { value } = await admin.invoke(lookup.operation, lookup.args);
  const id = value?.[named.idField];
  if (typeof id !== 'string' || !id) throw new Error(`${named.lookup} did not return the ${named.idField} of the created object`);
  if (!named.deleteById) return { compensate: { ...compensate, verify: { ...lookup, field: named.idField, id } }, created: { parameter: named.idField, id } };
  const { operation, parameter } = named.deleteById;
  return { compensate: { operation, args: { path: { [parameter]: id } } }, created: { parameter, id } };
}

// Checks, right before a compensation by name runs, that the name still leads to the object created.
export async function verifyCompensationTarget(admin, compensate) {
  const { verify } = compensate;
  if (!verify) return;
  const { value } = await admin.invoke(verify.operation, verify.args);
  if (value?.[verify.field] !== verify.id) throw new Error(`${verify.operation} now names another object than the one this workflow created`);
}
