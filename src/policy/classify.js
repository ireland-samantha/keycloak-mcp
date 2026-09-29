import { defaultCatalog, describeOperation } from '../catalog/index.js';
import {
  FIELD_REDACTIONS, IRREVERSIBLE_PATHS, NAMED_CREATE_TARGETS, OPERATION_OVERRIDES, RECEIPT_SENSITIVE_PATH_PARAMETER,
  SENSITIVE_FIELD, SENSITIVE_RESPONSE_PATHS, TOKEN_REFRESH_BEFORE_COMPENSATION,
} from './table.js';

const READ_METHODS = ['GET', 'HEAD'];

const entry = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

export function isMutation(key, operationCatalog = defaultCatalog()) {
  const op = describeOperation(key, operationCatalog);
  if (op.extension) return !op.readOnly;
  return entry(OPERATION_OVERRIDES, key)?.mutation ?? !READ_METHODS.includes(op.method);
}

// Bodyless PUT/DELETE pairs create and remove associations. Repeating PUT
// cannot undo an assignment, and DELETE may remove a pre-existing one.
function isAssociationPut(op, operationCatalog) {
  return op.method === 'PUT' && op.requestTypes.length === 0 && operationCatalog.byKey.has(`DELETE ${op.path}`);
}

export function isIrreversible(key, operationCatalog = defaultCatalog()) {
  const op = describeOperation(key, operationCatalog);
  if (!isMutation(key, operationCatalog)) return false;
  if (op.method === 'DELETE' || entry(OPERATION_OVERRIDES, key)?.irreversible === true) return true;
  if (op.extension) return op.irreversible;
  return isAssociationPut(op, operationCatalog) || IRREVERSIBLE_PATHS.some(({ pattern }) => pattern.test(op.path));
}

export function isSensitiveEndpoint(op) {
  return SENSITIVE_RESPONSE_PATHS.some(({ pattern }) => pattern.test(op.path));
}

export function isSensitiveField(op, name) {
  return SENSITIVE_FIELD.pattern.test(name) || (entry(FIELD_REDACTIONS, op.path)?.fields.includes(name) ?? false);
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

export function namedCreateTarget(key) {
  return entry(NAMED_CREATE_TARGETS, key);
}
