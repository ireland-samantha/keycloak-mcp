// Both markers name keycloak-mcp, so a value carrying one cannot be mistaken for a real one, and a
// request that echoes one back can be refused before it overwrites a real secret.
const MARKER = '[REDACTED by keycloak-mcp';
export const REDACTED = `${MARKER}]`;
export const REDACTED_ENDPOINT = `${MARKER}: sensitive endpoint]`;

// Keycloak stores what it is sent: a client secret PUT back as a marker becomes the new secret
// (server-spi-private/.../models/utils/RepresentationToModel.java:625-642), while a secret left out
// keeps the stored one. `value` is request text or bytes.
export function refuseRedactedValue(value) {
  if (value.includes(MARKER)) throw new Error(`request contains a value redacted by keycloak-mcp (${REDACTED}); send the real value or leave the field out`);
}
