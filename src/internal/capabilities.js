// The unchecked executor of each KeycloakAdmin, which sends any catalog operation, mutations included.
// Only the workflow runner calls it, after preflight and under the realm lock. The package entry point
// does not export this module, and a WeakMap entry, unlike a method or a symbol-keyed property, cannot
// be reached by reflecting on the admin object.
const executors = new WeakMap();

export function grantExecute(admin, execute) {
  executors.set(admin, execute);
}

export function execute(admin, key, args) {
  const run = executors.get(admin);
  if (!run) throw new Error('workflow steps need a KeycloakAdmin');
  return run(key, args);
}
