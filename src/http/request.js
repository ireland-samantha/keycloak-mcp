import { defaultCatalog, describeOperation } from '../catalog/index.js';
import { DEFAULT_BODY_BYTES } from '../config.js';
import { expandPathTemplate, pathParameterNames } from '../internal/path-template.js';
import { assertOperationAllowed } from '../policy/access.js';
import { MULTI_SEGMENT_PATH_PARAMETER } from '../policy/table.js';
import { encodeBody } from './body.js';

const isDotSegment = value => ['.', '..'].includes(value);

function encodeSegments(value) {
  const segments = String(value).replace(/^\//, '').split('/');
  if (segments.some(segment => !segment || isDotSegment(segment) || segment.includes('\\'))) throw new Error('unsafe group path');
  return segments.map(encodeURIComponent).join('/');
}

// {realm} is always the configured realm; every other value must stay inside its own path segment.
function expandPath(config, template, inputPath) {
  const names = pathParameterNames(template);
  if (Object.keys(inputPath).some(name => !names.includes(name))) throw new Error('unknown path parameter');
  return expandPathTemplate(template, name => {
    const value = name === 'realm' ? config.realm : inputPath[name];
    if (value === undefined || value === null || String(value) === '') throw new Error(`missing path parameter: ${name}`);
    if (name === 'realm' && inputPath.realm !== undefined && inputPath.realm !== config.realm) throw new Error('realm cannot be overridden');
    if (name === MULTI_SEGMENT_PATH_PARAMETER.name) return encodeSegments(value);
    if (isDotSegment(String(value)) || /[\\/]/.test(String(value))) throw new Error(`unsafe path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
}

function appendQuery(url, op, query) {
  const allowed = new Set(op.parameters.filter(parameter => parameter.in === 'query').map(parameter => parameter.name));
  for (const [name, value] of Object.entries(query)) {
    if (!allowed.has(name)) throw new Error(`unknown query parameter: ${name}`);
    for (const item of Array.isArray(value) ? value : [value]) if (item !== null && item !== undefined) url.searchParams.append(name, String(item));
  }
}

// Validates a call against the catalog and configuration and returns { op, url, body, headers } without sending it.
export function buildRequest(config, key, args = {}, operationCatalog = defaultCatalog()) {
  const op = describeOperation(key, operationCatalog);
  assertOperationAllowed(config, op, operationCatalog);
  const url = new URL(`${config.baseUrl}${expandPath(config, op.path, args.path ?? {})}`);
  appendQuery(url, op, args.query ?? {});
  let body;
  const headers = {};
  if (args.body !== undefined || args.bodyBase64 !== undefined) {
    const encoded = encodeBody(op, args, config.maxBodyBytes ?? DEFAULT_BODY_BYTES);
    body = encoded.body;
    if (encoded.contentType) headers['content-type'] = encoded.contentType;
  }
  if (args.accept) {
    if (!op.responseTypes.includes(args.accept)) throw new Error('accept type is not declared for this operation');
    headers.accept = args.accept;
  }
  return { op, url: url.toString(), body, headers };
}
