// Reads and workflow steps shared by the mock scenarios.
export const readRealm = { operation: 'GET /admin/realms/{realm}' };

// The default mock answers this read 404 ("User not found"), which fails a workflow after its writes.
export const missingUser = { operation: 'GET /admin/realms/{realm}/users/{user-id}', args: { path: { 'user-id': 'missing' } } };

export const realmUpdate = { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'changed' } },
  compensate: { operation: 'PUT /admin/realms/{realm}', args: { body: { displayName: 'original' } } } };

// A create compensated by deleting the child that Keycloak's Location header names.
export function createStep(collection, idName, body) {
  return { operation: `POST /admin/realms/{realm}/${collection}`, args: { body },
    compensate: { operation: `DELETE /admin/realms/{realm}/${collection}/{${idName}}`, args: { path: { [idName]: '$step.locationId' } } } };
}
