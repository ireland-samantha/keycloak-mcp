# Security

Please report suspected vulnerabilities privately through the repository's GitHub security advisory flow. Do not include live Keycloak credentials, tokens, or user data in issues, logs, or reproductions.

The service-account client is the security boundary. Grant only the roles needed for the configured realm. Keep its secret outside the repository in a mode 0600 configuration file, rotate it if exposure is suspected, and monitor Keycloak admin events. Keep writes disabled unless a compensating workflow and a lock mode are configured.

Certificate and keystore endpoints are redacted by default, including downloads that can contain a private key. Enabling `KEYCLOAK_MCP_ALLOW_SENSITIVE_READS=true` exposes those responses to the caller; use a separate, tightly scoped service account and output channel when that access is required.

This package cannot make multiple Keycloak Admin REST calls atomic. Consult the workflow receipt and the affected Keycloak resources after any timeout, crash, 5xx, or incomplete compensation.
