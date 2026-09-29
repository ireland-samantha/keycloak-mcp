import { isMutation } from './classify.js';

// Refuses, before a request is built, an operation this configuration may not call.
export function assertOperationAllowed(config, op, operationCatalog) {
  if (op.extension && !op.serviceAccountSupported) throw new Error('extension operation requires a non-service-account credential');
  const mutation = isMutation(op.key, operationCatalog);
  if (mutation && !config.allowWrite) throw new Error('writes are disabled');
  // A route without {realm} acts on every realm the token can see: GET /admin/realms returns each full
  // representation (RealmsAdminResource.java:113-124). Refusing such routes, reads included, keeps
  // pinning independent of the response shape, which filtering would depend on.
  if (!op.path.includes('{realm}') && !config.allowRealmAdmin) throw new Error('realm administration is disabled');
}
