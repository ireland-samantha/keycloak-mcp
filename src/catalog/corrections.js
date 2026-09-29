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

const appliesTo = (correction, version) => correction.versions.includes(version);

// The correction for an operation path as the bundled definition spells it.
export function correctionForDefinitionPath(version, definitionPath) {
  return PATH_PARAMETER_CORRECTIONS.find(correction => appliesTo(correction, version) && correction.definitionPath === definitionPath) ?? null;
}

// The correction that produced a catalog operation path.
export function correctionForPath(version, path) {
  return PATH_PARAMETER_CORRECTIONS.find(correction => appliesTo(correction, version) && correction.path === path) ?? null;
}
