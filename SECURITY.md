# Security

Please report suspected vulnerabilities privately through the repository's GitHub security advisory flow. Do not include live Keycloak credentials, tokens, or user data in issues, logs, or reproductions.

The service-account client is the security boundary. Grant only the roles needed for the configured realm. Keep its secret outside the repository in a mode 0600 configuration file, rotate it if exposure is suspected, and monitor Keycloak admin events. Keep writes disabled unless a compensating workflow and a lock mode are configured.

Certificate and keystore endpoints, client initial-access tokens, and detailed admin-event representations are redacted by default, including downloads that can contain a private key and the private key read from an uploaded keystore. Enabling `KEYCLOAK_MCP_ALLOW_SENSITIVE_READS=true` exposes those responses to the caller; use a separate, tightly scoped service account and output channel when that access is required.

`KEYCLOAK_MCP_ALLOW_IRREVERSIBLE` is the operator's gate for changes no compensation can undo. Besides the irreversible routes, it covers request bodies that set a password or a secret, drop an identity provider's stored client secret, send a stored credential to a new address (an LDAP or Ipatuura connection, an identity provider's token endpoint, the SMTP settings), turn off or narrow event recording or schedule stored events or admin events for deletion, rename a realm, role or required action, or delete a client's authorization settings or service-account user, and any JSON body it cannot read the way Keycloak does. The rules are listed in the README under "How operations are classified" and in `src/policy/table.js`. Keep the gate off where an LLM agent drives the tools: with it on, a step marked `irreversible: true` can do any of these. Admin events are a monitoring control only while turning them off or expiring them needs that gate.

Some reads have effects in Keycloak: listing or searching users in a realm with user federation contacts the directory with its stored bind credential, can import users, and can delete a user whose federation link no longer validates. Treat read access to a federated realm accordingly.

This package cannot make multiple Keycloak Admin REST calls atomic. Consult the workflow receipt and the affected Keycloak resources after any timeout, crash, 5xx, or incomplete compensation.
