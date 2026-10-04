# Recorded Keycloak responses

`keycloak-head.json` holds the Admin REST responses that the mock Keycloak (`test/support/mock-keycloak.js`) serves by default, so mock scenarios see the status codes, headers and bodies a real server sends.

Provenance: recorded on 2026-09-29 from `quay.io/keycloak/keycloak:nightly` at image digest `sha256:6184d6c6fb25c9f013e2e803b56001e91efff023633c797f7114405aa0f98c94`, which reports server version `999.0.0-SNAPSHOT`. The recorder, `scripts/record-mock-fixtures.mjs`, ran against a disposable realm that it created, filled and then deleted. The same details are stored in the file's `provenance` field.

The recorder plants secrets wherever a Keycloak representation can carry one: the client secret, the rotated client secret and a SAML private key in client attributes, private JWK members inside the `jwks.string` attribute, a PEM private key and an API key in custom client attributes, an API key in a realm attribute, the SMTP password, the identity-provider client secret, an LDAP bind credential, an imported RSA key and a user password. `idp.uploadCertificate` is the identity-provider certificate converter's answer to a PKCS12 keystore that Keycloak generated for the fixture client: it returns the keystore's private key in clear next to the certificate and public key. `components.list` holds a realm's real components: the LDAP provider with its mappers, the default and imported key providers, and the client-registration policies. For the workflow scenarios it also records how Keycloak answers creates that a compensation must bind: `role.get` and `clientRole.get` give the ID of a role created by name, `idp.renameRefused` shows that an identity provider's alias cannot be changed, `authz.scope.createExisting` returns the existing scope for a name that is taken, and the `createWithId` responses show that an authorization scope or resource created with an ID nothing has is created with exactly that ID, or refused with 409 when its name is taken.

Scrubbing:
- every JWT (access, initial-access and registration tokens) is replaced with `<scrubbed-jwt>`;
- every planted secret that Keycloak returns in clear, and the private key it reads from the uploaded keystore, is replaced with `<scrubbed-secret>`, so the placeholders mark exactly where a real representation exposes a secret;
- values Keycloak masks itself, such as `**********`, are kept as sent;
- `{origin}` and `{realm}` stand for the server origin and realm name. The mock fills them in with its own values.

To refresh the file against another server, run:

```
KEYCLOAK_URL=http://127.0.0.1:18080 KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=... \
KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:nightly KEYCLOAK_IMAGE_DIGEST=sha256:... \
node scripts/record-mock-fixtures.mjs
```

Then review the diff: a changed response shape on Keycloak HEAD shows up there first. The recorder fails if a JWT or a planted secret survives scrubbing.
