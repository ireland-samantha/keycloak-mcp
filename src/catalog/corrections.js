// Request bodies that Keycloak handlers consume but a bundled OpenAPI definition omits; a correction
// without `versions` applies to every catalog version. Sources are Keycloak HEAD paths under
// services/src/main/java/org/keycloak/.
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
