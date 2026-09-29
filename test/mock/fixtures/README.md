# Recorded Keycloak responses

`keycloak-head.json` holds the Admin REST responses that the mock Keycloak (`test/support/mock-keycloak.js`) serves by default, so mock scenarios see the status codes, headers and bodies a real server sends.

Provenance: recorded on 2026-09-29 from `quay.io/keycloak/keycloak:nightly` at image digest `sha256:6184d6c6fb25c9f013e2e803b56001e91efff023633c797f7114405aa0f98c94`, which reports server version `999.0.0-SNAPSHOT`. The recorder, `scripts/record-mock-fixtures.mjs`, ran against a disposable realm that it created, filled and then deleted. The same details are stored in the file's `provenance` field.

Scrubbing:
- every JWT (access, initial-access and registration tokens) is replaced with `<scrubbed-jwt>`;
- the client, identity-provider, SMTP and user secrets the recorder set are replaced with `<scrubbed-secret>`;
- values Keycloak masks itself, such as `**********`, are kept as sent;
- `{origin}` and `{realm}` stand for the server origin and realm name. The mock fills them in with its own values.

To refresh the file against another server, run:

```
KEYCLOAK_URL=http://127.0.0.1:18080 KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=... \
KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:nightly KEYCLOAK_IMAGE_DIGEST=sha256:... \
node scripts/record-mock-fixtures.mjs
```

Then review the diff: a changed response shape on Keycloak HEAD shows up there first. The recorder fails if a JWT or a planted secret survives scrubbing.
