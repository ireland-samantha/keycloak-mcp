import { isMutation } from './classify.js';

// Refuses, before a request is built, an operation this configuration may not call.
export function assertOperationAllowed(config, op, operationCatalog) {
  if (op.extension && !op.serviceAccountSupported) throw new Error('extension operation requires a non-service-account credential');
  const mutation = isMutation(op.key, operationCatalog);
  if (mutation && !config.allowWrite) throw new Error('writes are disabled');
  if (!op.path.includes('{realm}') && mutation && !config.allowRealmAdmin) throw new Error('realm administration is disabled');
}
