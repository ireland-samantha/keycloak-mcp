// Corrections to a bundled OpenAPI definition where it disagrees with the Keycloak handlers; a correction
// without `versions` applies to every catalog version. Sources are Keycloak HEAD paths under
// services/src/main/java/org/keycloak/.

// Request bodies that Keycloak handlers consume but the definition omits.
const certificateUploadForm = {
  required: true,
  content: { 'multipart/form-data': { schema: { type: 'object', required: ['keystoreFormat', 'file'], properties: {
    keystoreFormat: { type: 'string' }, file: { type: 'string', format: 'binary' },
    keyAlias: { type: 'string' }, keyPassword: { type: 'string' }, storePassword: { type: 'string' },
  } } } },
};

export const REQUEST_BODY_CORRECTIONS = [
  {
    keys: ['POST /admin/realms/{realm}/users/{user-id}/federated-identity/{provider}'],
    versions: ['26.3.5'],
    requestTypes: ['application/json'],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FederatedIdentityRepresentation' } } } },
    reason: 'The 26.3.5 definition omits the FederatedIdentityRepresentation JSON body that addFederatedIdentity reads.',
    source: 'services/resources/admin/UserResource.java:522-533',
  },
  {
    keys: [
      'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/upload',
      'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/upload-certificate',
      'POST /admin/realms/{realm}/identity-provider/upload-certificate',
    ],
    requestTypes: ['multipart/form-data'],
    requestBody: certificateUploadForm,
    reason: 'Both definitions omit the multipart form these uploads read: keystoreFormat and file, plus keyAlias, keyPassword and storePassword for keystores.',
    source: 'services/resources/admin/ClientAttributeCertificateResource.java:148-179; IdentityProvidersResource.java:146-152; services/util/CertificateInfoHelper.java:237-281',
  },
];

export function requestBodyCorrection(version, key, detail) {
  if (detail.requestBody) return null;
  return REQUEST_BODY_CORRECTIONS.find(correction => correction.keys.includes(key) && (!correction.versions || correction.versions.includes(version))) ?? null;
}

// Paths that name one parameter twice, so a single value filled both places. The later occurrence is
// renamed as Keycloak HEAD names it; `definitionPath` is the path in the bundled definition.
export const PATH_PARAMETER_CORRECTIONS = [
  {
    versions: ['26.3.5'],
    definitionPath: '/admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}/composites/clients/{client-uuid}',
    path: '/admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}/composites/clients/{targetClientUuid}',
    parameter: 'targetClientUuid',
    reason: 'The 26.3.5 definition names both the role\'s client and the composite\'s client {client-uuid}, so a lookup across two clients could not be expressed; the handler reads the second as a parameter of its own, which HEAD names targetClientUuid.',
    source: 'services/resources/admin/RoleContainerResource.java:447-458',
  },
];

// Query parameters a definition declares on a path item although the operations under it do not read
// them. An operation that declares one itself keeps it; for the others it is dropped, so a caller is
// refused instead of sending a filter Keycloak silently ignores.
export const IGNORED_PATH_ITEM_PARAMETERS = [
  {
    pathPrefix: '/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource',
    in: 'query',
    names: ['_id', 'deep', 'exactName', 'first', 'matchingUri', 'max', 'name', 'owner', 'scope', 'type', 'uri'],
    reason: 'Keycloak\'s generated definition copies the query parameters of ResourceSetService\'s public find overload, which has no HTTP-method annotation, onto every path item of the authorization resource collection. Only the collection GET, which declares them itself, reads them, and the search GET reads name alone; the create, the get, update and delete by ID and the attributes, scopes and permissions reads read none (surface-04).',
    source: 'authorization/admin/ResourceSetService.java:105-116, :158-222, :231-360, :362-374, :391-422',
  },
];

const coversPath = (prefix, path) => path === prefix || path.startsWith(`${prefix}/`);
const isIgnored = (definitionPath, parameter) => IGNORED_PATH_ITEM_PARAMETERS.some(rule =>
  coversPath(rule.pathPrefix, definitionPath) && rule.in === parameter.in && rule.names.includes(parameter.name));

// The OpenAPI parameters of one operation: its path item's, less those the operation redeclares (a
// parameter is identified by name and location, and the operation's own overrides the path item's) and
// those IGNORED_PATH_ITEM_PARAMETERS drops, followed by the operation's own.
export function operationParameters(definitionPath, pathItem, operation) {
  const own = operation.parameters ?? [];
  const redeclared = parameter => own.some(item => item.name === parameter.name && item.in === parameter.in);
  return [...(pathItem.parameters ?? []).filter(parameter => !redeclared(parameter) && !isIgnored(definitionPath, parameter)), ...own];
}

const appliesTo = (correction, version) => correction.versions.includes(version);

// The correction for an operation path as the bundled definition spells it.
export function correctionForDefinitionPath(version, definitionPath) {
  return PATH_PARAMETER_CORRECTIONS.find(correction => appliesTo(correction, version) && correction.definitionPath === definitionPath) ?? null;
}

// The correction that produced a catalog operation path.
export function correctionForPath(version, path) {
  return PATH_PARAMETER_CORRECTIONS.find(correction => appliesTo(correction, version) && correction.path === path) ?? null;
}
