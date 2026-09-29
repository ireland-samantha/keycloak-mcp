// Compensation path values that stand for the ID the create step's response returns.
export const LOCATION_ID = '$step.locationId';
export const RESPONSE_ID = '$step.responseId';
const ID_MARKERS = new Set([LOCATION_ID, RESPONSE_ID]);

export const isIdMarker = value => ID_MARKERS.has(value);

// The [name, marker] path entries of `args` that are bound to a created ID.
export function idBindings(args) {
  return Object.entries(args?.path ?? {}).filter(([, value]) => isIdMarker(value));
}

// `args` with each marker replaced by a placeholder, so preflight can build the compensation request.
export function withPendingIds(args) {
  const path = Object.fromEntries(Object.entries(args?.path ?? {}).map(([name, value]) => [name, isIdMarker(value) ? 'created-id-pending' : value]));
  return { ...args, path };
}
