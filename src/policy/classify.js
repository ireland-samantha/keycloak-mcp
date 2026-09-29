import { defaultCatalog, describeOperation } from '../catalog/index.js';
import { jsonBodyOf, UNREADABLE_JSON } from '../internal/json.js';
import { isJsonType, requestContentType } from '../internal/media-type.js';
import { withoutParameterNames } from '../internal/path-template.js';
import { setsSecret } from './redaction.js';
import {
  ADMIN_CLIENT_ROUTES, GENERATED_ID_PARAMETER, IRREVERSIBLE_BODIES, IRREVERSIBLE_PATHS, NAMED_CREATE_TARGETS, OPERATION_OVERRIDES,
  RECEIPT_SENSITIVE_PATH_PARAMETER, SENSITIVE_RESPONSE_PATHS, TOKEN_REFRESH_BEFORE_COMPENSATION, UNREADABLE_BODY, UPSERT_CREATES,
} from './table.js';

const READ_METHODS = ['GET', 'HEAD'];

const entry = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

// The names of the ADMIN_CLIENT_ROUTES rules that cover a method and path, whatever its parameters are named.
export function adminClientRouteNames(method, path) {
  const route = withoutParameterNames(path);
  return Object.entries(ADMIN_CLIENT_ROUTES).filter(([, rule]) => rule.methods.includes(method) && rule.path.test(route)).map(([name]) => name);
}

const adminClientRoute = op => entry(ADMIN_CLIENT_ROUTES, adminClientRouteNames(op.method, op.path)[0]);

export function isMutation(key, operationCatalog = defaultCatalog()) {
  const op = describeOperation(key, operationCatalog);
  if (op.extension) return !op.readOnly;
  return adminClientRoute(op)?.mutation ?? entry(OPERATION_OVERRIDES, key)?.mutation ?? !READ_METHODS.includes(op.method);
}

// Bodyless PUT/DELETE pairs create and remove associations. Repeating PUT
// cannot undo an assignment, and DELETE may remove a pre-existing one.
function isAssociationPut(op, operationCatalog) {
  return op.method === 'PUT' && op.requestTypes.length === 0 && operationCatalog.byKey.has(`DELETE ${op.path}`);
}

export function isIrreversible(key, operationCatalog = defaultCatalog()) {
  const op = describeOperation(key, operationCatalog);
  if (!isMutation(key, operationCatalog)) return false;
  const route = adminClientRoute(op);
  if (route) return route.irreversible;
  if (op.method === 'DELETE') return true;
  const override = entry(OPERATION_OVERRIDES, key)?.irreversible;
  if (override !== undefined) return override;
  if (op.extension) return op.irreversible;
  return isAssociationPut(op, operationCatalog) || IRREVERSIBLE_PATHS.some(({ pattern }) => pattern.test(op.path));
}

const coversOperation = (rule, op) => Boolean(rule.operations?.includes(op.key) || rule.methods?.includes(op.method));

// The names of the IRREVERSIBLE_BODIES rules that apply to an operation, whatever its body.
export function bodyRuleNames(key, operationCatalog = defaultCatalog()) {
  const op = describeOperation(key, operationCatalog);
  return Object.entries(IRREVERSIBLE_BODIES).filter(([, rule]) => coversOperation(rule, op)).map(([name]) => name);
}

// Whether Keycloak reads the call's body as JSON, which decides whether an unreadable bodyBase64 counts.
function sentAsJson(op, args) {
  const type = requestContentType(op, args);
  return typeof type === 'string' && isJsonType(type);
}

// The IRREVERSIBLE_BODIES rules that a call with `args` triggers, as [{ name, summary }], or UNREADABLE_BODY
// alone when they cannot judge it. The body is judged as the JSON Keycloak reads; `config` gives the realm
// and the operator's secret attributes.
export function irreversibleBodyRules(key, args = {}, config, operationCatalog = defaultCatalog()) {
  const names = bodyRuleNames(key, operationCatalog);
  if (!names.length) return [];
  const body = jsonBodyOf(args, sentAsJson(describeOperation(key, operationCatalog), args));
  if (body === UNREADABLE_JSON) return [{ name: UNREADABLE_BODY.name, summary: UNREADABLE_BODY.summary }];
  const request = { body, path: { ...args.path, realm: config.realm }, setsSecret: () => setsSecret(body, config.secretAttributes) };
  return names.filter(name => IRREVERSIBLE_BODIES[name].applies(request)).map(name => ({ name, summary: IRREVERSIBLE_BODIES[name].summary }));
}

export function isSensitiveEndpoint(op) {
  return adminClientRoute(op)?.sensitive ?? SENSITIVE_RESPONSE_PATHS.some(({ pattern }) => pattern.test(op.path));
}

export function isSensitiveReceiptParameter(name) {
  return RECEIPT_SENSITIVE_PATH_PARAMETER.pattern.test(name);
}

export function invalidatesServiceToken(key) {
  return entry(OPERATION_OVERRIDES, key)?.invalidatesServiceToken === true;
}

export function needsFreshTokenToCompensate(operation, compensation) {
  return TOKEN_REFRESH_BEFORE_COMPENSATION.some(pair => pair.operation === operation && pair.compensation === compensation);
}

export function isGeneratedIdParameter(name) {
  return GENERATED_ID_PARAMETER.pattern.test(name);
}

export function namedCreateTarget(key) {
  return entry(NAMED_CREATE_TARGETS, key);
}

// The body field that names the created object's ID, for a create Keycloak may answer with an existing one.
export function upsertIdField(key) {
  return entry(UPSERT_CREATES, key)?.idField;
}
