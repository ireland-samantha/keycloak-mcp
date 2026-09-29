# keycloak-mcp

A standalone Keycloak Admin REST interface for Claude Code, Codex, OpenClaw, and JavaScript callers. It uses **OAuth 2.0 client credentials only**. No user password, browser login, or operator token is accepted by the runtime.

The runtime serves one pinned catalog of Keycloak Admin REST operations, generated from an official OpenAPI definition. Search and describe tools make the selected surface usable without placing hundreds of tools in an LLM context. Set `KEYCLOAK_MCP_CATALOG_VERSION` to the catalog that matches your server:

| Version | Generated from | Use for |
| --- | --- | --- |
| `latest` (default) | [the current release's definition](https://www.keycloak.org/docs-api/latest/rest-api/openapi.json), downloaded on 2026-09-26 (26.7.x) | a server on that release |
| `26.3.5` | [the Keycloak 26.3.5 definition](https://www.keycloak.org/docs-api/26.3.5/rest-api/openapi.json) | a 26.3.5 server |
| `nightly` | [the Keycloak HEAD definition](https://www.keycloak.org/docs-api/nightly/rest-api/openapi.json), plus the operations only the Java admin client reaches | a server built from Keycloak's main branch, such as `quay.io/keycloak/keycloak:nightly` |

The Java admin client (`org.keycloak:keycloak-admin-client`) reaches operations that Keycloak's OpenAPI definition leaves out, such as typed authorization policies and permissions, user-storage synchronization, cache clearing, LDAP connection tests, verifiable-credential grants and server information. When `data/admin-client-supplement-nightly.json` is bundled, the `nightly` catalog adds them; the Java equivalence module generates that file from the admin client's HEAD snapshot (`mvn -f equivalence/pom.xml -Psupplement`). `keycloak_describe_operation` gives each operation an `origin`, `openapi` or `admin-client`. An admin-client operation also names the admin-client methods that reach it (`adminClient`), and the schemas it references resolve through `keycloak_describe_schema` like the definition's own.

Each catalog records the SHA-256 of the definition it was built from, and `keycloak_search_operations` reports it. `npm run catalog:update` regenerates all three from upstream; review their diffs and rerun checks before release. The `nightly` catalog moves with Keycloak HEAD, so regenerate it before relying on it against a newer build. Installed SPI routes can be added through a private, deployment-specific catalog; they are not part of Keycloak's official Admin REST specification.

## Install and configure

Requires Node.js 22 or newer. In a clone of this repository:

```sh
npm ci
npm run check
```

Create a confidential Keycloak client with **service accounts enabled**. Grant its service-account user only the `realm-management` roles needed for the target realm. Keep the secret in a private JSON file outside the repository, for example `/Users/you/.config/keycloak-mcp/service-account.json`:

```json
{
  "KEYCLOAK_BASE_URL": "https://keycloak.example.com",
  "KEYCLOAK_REALM": "example",
  "KEYCLOAK_AUTH_REALM": "master",
  "KEYCLOAK_CLIENT_ID": "keycloak-mcp-service",
  "KEYCLOAK_CLIENT_SECRET": "replace-me",
  "KEYCLOAK_MCP_CATALOG_VERSION": "26.3.5",
  "KEYCLOAK_MCP_ALLOW_WRITE": "false"
}
```

Set file mode `0600`. The runtime rejects group-readable or world-readable configuration files. `KEYCLOAK_AUTH_REALM` names the realm that issues the service-account token; `KEYCLOAK_REALM` is the administered realm. The base URL must use HTTPS, except for loopback development. When `KEYCLOAK_MCP_CONFIG` names this file, it is authoritative for every setting it defines: environment variables only supply settings the file leaves out, and an empty environment value counts as unset. Switches such as `KEYCLOAK_MCP_ALLOW_WRITE` accept `true` or `"true"` and `false` or `"false"`; any other value stops startup with an error.

### Claude Code

```sh
claude mcp add -s user keycloak -e KEYCLOAK_MCP_CONFIG=/absolute/path/service-account.json -- node /absolute/path/keycloak-mcp/src/index.js
```

### Codex

```sh
codex mcp add keycloak --env KEYCLOAK_MCP_CONFIG=/absolute/path/service-account.json -- node /absolute/path/keycloak-mcp/src/index.js
```

### OpenClaw

The package is a native [OpenClaw](https://github.com/openclaw/openclaw) plugin. The root `openclaw.plugin.json` declares the five tools in `contracts.tools`, and `package.json` points `openclaw.extensions` at `./openclaw/index.js`. The npm name `keycloak-mcp` belongs to an unrelated package, so install from a tarball packed from this repository, not a bare npm spec:

```sh
npm pack
openclaw plugins install npm-pack:./keycloak-mcp-0.1.1.tgz --force --accept-capabilities
openclaw config set plugins.entries.keycloak-mcp.config.configPath /absolute/path/service-account.json
openclaw plugins inspect keycloak-mcp --runtime
```

`--force` confirms a source outside ClawHub, and `--accept-capabilities` accepts the declared tool surface; review both before passing them. The config file must be private (`0600`) and visible inside the OpenClaw process or container. When `configPath` is set, the file is authoritative and ambient `KEYCLOAK_*` variables cannot override it. Without `configPath`, it reads `KEYCLOAK_MCP_CONFIG` or the `KEYCLOAK_*` variables from its process environment; with no configuration at all, registration fails and `plugins inspect --runtime` reports the error. It registers the same five tools individually. To upgrade, pack the new version and reinstall it with `--force`: `openclaw plugins update keycloak-mcp` resolves the name on npm. If OpenClaw runs in a rootless container, ensure the mounted package appears owned by the container user or root; its loader can block an otherwise readable plugin with untrusted ownership. The workflow lock database must be reachable from that container before enabling writes. The [validation record](docs/validation-history/2026-09/VALIDATION.md#upstream-openclaw-integration) names the OpenClaw release this was run against; validate the extension against your OpenClaw release before enabling it.

## Tools

| Tool | Effect |
| --- | --- |
| `keycloak_search_operations` | Find operations by path, summary, tag, or method; paginated. |
| `keycloak_describe_operation` | Show full parameters, request bodies, and response schemas for one exact operation key. |
| `keycloak_describe_schema` | Expand a Keycloak representation referenced by an operation. |
| `keycloak_read` | Call a read-only catalog operation with the configured service account and realm: GET, and the POSTs that change nothing (client-description and identity-provider certificate conversion, authorization policy and permission evaluation, client certificate download, partial realm export). |
| `keycloak_workflow` | Preflight by default. Execute up to 20 steps only with `execute=true`. |

An operation key is `METHOD /admin/realms/{realm}/...` or, for a configured SPI route, `METHOD /realms/{realm}/...`. The caller supplies named path parameters in `args.path`, query values in `args.query`, and request data in `args.body` or `args.bodyBase64`. Content types must appear in the pinned specification or extension catalog. Without `args.contentType`, a string body is sent as the operation's declared `text/*` type, else its XML or YAML type, and any other body as JSON when the operation accepts JSON; failing those, the first declared type is used. Responses are requested as JSON whenever the operation offers JSON; `args.accept` selects another declared response type. A read returns `{ status, contentType, value }`, where `contentType` is the response's media type; an empty body has neither `contentType` nor `value`, so it is never confused with a JSON `null`. JSON numbers are returned exactly as Keycloak wrote them, including integers beyond 2^53; tool arguments, however, are parsed by the MCP SDK, which rounds such integers before keycloak-mcp sees them. Binary responses are returned as base64. Requests and responses default to a 1 MiB limit; `KEYCLOAK_MCP_MAX_BODY_BYTES` can raise it to at most 64 MiB in a private deployment config. Response streams stop when they cross that limit. Over stdio, one MCP message carries at most 10 MiB (the MCP SDK's default at both ends), so the stdio server refuses to start with a limit above 7,815,168 bytes, the largest body whose base64 form fits one message; OpenClaw and JavaScript callers keep the 64 MiB ceiling. An incoming stdio message over 10 MiB is dropped with a JSON-RPC error that names no request, since its id was in the dropped bytes, and a result that would need more than 10 MiB becomes a tool error; the session continues either way. Larger responses can overwhelm an LLM context, so use Keycloak pagination where available.

### Installed SPI routes

Put a deployment-specific JSON catalog outside the repository, set its mode to `0600`, and set `KEYCLOAK_MCP_EXTENSION_CATALOG` to its absolute path in the private service-account config. Each route must declare whether it is read-only and whether a service-account token can call it:

```json
{
  "source": "deployed provider inventory and route review",
  "operations": [
    {
      "method": "GET",
      "path": "/realms/{realm}/example/info",
      "summary": "Example provider information",
      "tags": ["example"],
      "readOnly": true,
      "serviceAccountSupported": true,
      "responseTypes": ["application/json"]
    }
  ]
}
```

The loader rejects duplicate official routes, URLs outside the configured realm, unsafe paths, and extension operations without an explicit service-account assessment. User-token routes can be listed with `serviceAccountSupported: false` for discovery, but the runtime refuses to call them. Extension mutations default to irreversible and require the explicit irreversible override, even when a compensation is supplied. Pin the catalog to the **running image and provider hashes**, then recheck it after every provider deployment. Authentication flows, mappers, custom grants, and introspection providers may have no new REST path; record those separately in the deployment inventory.

Example dry run:

```json
{
  "steps": [
    {
      "operation": "PUT /admin/realms/{realm}",
      "args": { "body": { "displayName": "New name" } },
      "compensate": {
        "operation": "PUT /admin/realms/{realm}",
        "args": { "body": { "displayName": "Previous name" } }
      }
    }
  ]
}
```

For a `POST` that returns a `Location` ending in its new resource ID, a compensation path parameter can use `"$step.locationId"`. Some Keycloak creates, including authorization resources and scopes, return a JSON `id` or `_id` without `Location`; use `"$step.responseId"` for a generated UUID in that response. Keycloak answers those two creates with an existing scope or resource instead of refusing a name that is taken, so when a compensation is bound to the created ID, keycloak-mcp names the new object itself with a random UUID in the body (`id` for a scope, `_id` for a resource): Keycloak then creates exactly that object or refuses the step with 409, and a response that names any other object is not compensated. Such a body must not carry its own `id` or `_id`. A resource create that names scopes which do not exist creates them as well, and deleting the resource leaves them. The runtime accepts one binding only for a `DELETE` of that collection's direct child, checks any Location against the configured Keycloak origin and response ID, and records the resolved path in the private workflow receipt. Where keycloak-mcp withholds the create's response, as for client initial-access tokens, `$step.responseId` is refused unless sensitive reads are enabled; use `$step.locationId` there. A missing or conflicting ID stops the run `IN_DOUBT` for manual reconciliation, and because Keycloak accepted that step, the result's `failedStepResponse` gives its `status`, `location` and (redacted) `value` so the object it created can be found; the receipt records the status and Location. Each entry of a workflow result's `completed` list gives the step's `operation` and HTTP `status`, Keycloak's `location` when it sent one, and the `id` of the resource the step created when a compensation was bound to it; later steps can use that ID. The receipt records the same, except that it withholds a Location whose path carries a withheld parameter.

Global `POST /admin/realms` is allowed only when the request body names the configured `KEYCLOAK_REALM` and its compensation is `DELETE /admin/realms/{realm}`. Before compensating a successful realm creation, the client obtains a fresh service-account token: Keycloak may add the new realm's admin roles only after the earlier token was issued. Global administration still requires the explicit `KEYCLOAK_MCP_ALLOW_REALM_ADMIN=true` setting and appropriate service-account roles.

The public JavaScript API exports `KeycloakAdmin`, `WorkflowBuilder`, `runWorkflow`, `listOperations`, and `describeOperation` from `keycloak-mcp`. For example:

```js
import { KeycloakAdmin, WorkflowBuilder, configFromEnv } from 'keycloak-mcp';
const admin = new KeycloakAdmin(configFromEnv());
const workflow = new WorkflowBuilder(admin)
  .step('PUT /admin/realms/{realm}', { body: { displayName: 'New name' } }, {
    operation: 'PUT /admin/realms/{realm}',
    args: { body: { displayName: 'Previous name' } },
  });
await workflow.plan(); // no network write
await workflow.run();
```

`step(operation, args, compensation, { irreversible: true })` marks a step irreversible, like `irreversible: true` on a `runWorkflow` step; pass `null` as the compensation for a step that has none.

Certificate uploads accept `contentType: 'multipart/form-data'` with a `body` object. Text fields are strings; a file field is `{ filename, contentType, base64 }`. The client builds the boundary and checks the decoded-size budget before allocating a file. For example, use `keystoreFormat: 'Certificate PEM'` and a `file` object for either certificate upload route. State-changing certificate uploads require a workflow with an explicit compensation or irreversible override; the identity-provider upload-certificate converter is read-only, and the private key it reads from an uploaded keystore is redacted like every `privateKey` field.

## Write safety and actual guarantees

Reads are enabled by default. To execute mutations, set `KEYCLOAK_MCP_ALLOW_WRITE=true`, supply an explicit compensating operation for **every** mutation, and use one of:

- `KEYCLOAK_MCP_SINGLE_WRITER=true` for a deployment that truly has one process writing this realm; or
- `KEYCLOAK_MCP_LOCK_DATABASE_URL` for a shared PostgreSQL advisory lock across cooperating instances.

The lock is per Keycloak base URL and realm. It does not fence external Keycloak administrators or unrelated clients. The PostgreSQL lock is a session-level advisory lock, so connect directly or through session pooling; PgBouncer transaction pooling cannot hold it. The connection is checked before each step and before each compensation. If it drops (an `idle_session_timeout`, a failover), the server has released the lock, so the run stops with `lost the PostgreSQL lock connection` and ends `IN_DOUBT` without compensating, because another workflow may already hold the realm. A local file receipt is written before and after each step under `KEYCLOAK_MCP_JOURNAL_DIR` (default `~/.local/state/keycloak-mcp`). The receipt includes operation keys and path parameters, but omits request bodies and query values; restrict access to it because path parameters can identify users or clients. A step is sent only after its receipt is written, so a journal that cannot be written stops the run before the next request. Once Keycloak has changed, a receipt write that fails never stops the compensation that follows: the run finishes and its result lists the failed writes in `journalErrors`. A lock that cannot be released after the run is reported in `lockReleaseError`; once a request has been sent, the result, with its `runId`, is always returned rather than an error. A crash, timeout, lost lock, or 5xx can leave the current step **in doubt** even when prior steps were compensated. On an operation error, the result is `IN_DOUBT`; `failedStepMayHaveCommitted` is false for a read-only failed step and for a step whose request was never sent (its lock check, its in-flight receipt or the token grant failed first), and `priorStepsCompensated` reports only whether earlier compensation calls succeeded. Read back affected resources and reconcile using the receipt's `runId`.

Irreversible operations, listed under "How operations are classified" below, require the explicit irreversible override. Preflight permits an otherwise irreversible compensation when it deletes the realm just created by the matching global create step, deletes a direct child using that create response's generated ID, or deletes a newly created realm role, client role or identity-provider instance using the exact nonblank name or alias in the create body. The named exception is limited to those three create routes. Names can change, so right after such a create keycloak-mcp reads the new object by its name for its immutable ID: a role is then compensated through `DELETE .../roles-by-id/{role-id}`, whatever it is called by then, and an identity provider, which Keycloak addresses only by alias, is deleted by alias only if that alias still has the created `internalId`. A `POST` mutation can compensate only with a `DELETE` of its created direct child, keeping the same parent path; an ID or UUID path parameter must use `$step.locationId` or `$step.responseId`, not a caller-supplied ID. A representation update compensation must use `PUT` or `PATCH` on the same route, path parameters, and query. Repeating an association `PUT` cannot undo the association; a `DELETE` may remove a pre-existing association, so these operations require the irreversible override until prior state can be proved. Other compensation bodies remain caller-declared, so preflight cannot establish that they restore prior state. Role-mapping additions require an explicit irreversible override because deleting the mapping could remove a role that was already assigned before the workflow. A successful create and compensating DELETE still require readback to establish the final state, and the lock does not fence other Keycloak writers.

Read-only operations retry HTTP 502, 503, and 504 at most twice with short delays and return an `attempts` count when a retry occurs. A safe GET also refreshes an invalidated service-account token and retries once after HTTP 401. A successful `logout-all` clears the cached token. Mutations, including side-effecting GET operations, are never retried automatically because a failed response may follow a committed change. A failed call reports the HTTP status, the number of attempts and Keycloak's own error text (`error`, `errorMessage` or `error_description`), cut to 300 characters and redacted like a response. A redirect is reported with its status and never followed.

Operations outside the configured realm, including reads such as `GET /admin/realms` that return every realm the service account can see, are blocked unless `KEYCLOAK_MCP_ALLOW_REALM_ADMIN=true`. The runtime rejects arbitrary URLs, unknown operation keys, undeclared query and content types, path traversal, redirects, and direct mutation calls through `keycloak_read`. Secret fields of Keycloak representations, private JSON Web Key members (as in a client's `jwks.string`) and private keys in any string, whether PEM or the base64 DER without a header that Keycloak writes, client initial-access tokens, detailed admin-event representations, client certificate info and keystore downloads, installation exports, generated examples, and known secret endpoints are redacted unless `KEYCLOAK_MCP_ALLOW_SENSITIVE_READS=true`. The secret fields are listed, with the Keycloak source that makes each one secret, in `src/policy/table.js`: client secrets, rotated secrets, private-key attributes and registration access tokens, which Keycloak returns in clear to a client manager, the private key of an uploaded keystore, and the SMTP, identity-provider, LDAP, key-provider, reCAPTCHA and credential secrets that Keycloak masks as `**********`. Every other field, and Keycloak's own mask, is returned as sent. Keycloak cannot know which custom attribute holds a secret and returns them all in clear; list such keys in `KEYCLOAK_MCP_SECRET_ATTRIBUTES` (comma-separated, or a JSON list in the config file) to redact them in every `attributes` and `config` map. A redacted value reads `[REDACTED by keycloak-mcp]` (or `[REDACTED by keycloak-mcp: sensitive endpoint]` for a withheld response). Keycloak would store such text as the real value, so any request whose path, query or body contains it is refused before it is sent: leave redacted fields out of an update, which keeps the stored secret.

### How operations are classified

Every operation-specific rule is in `src/policy/table.js`, each with its reason and the Keycloak source behind it, and the resulting classification of every operation in each bundled catalog is pinned in `test/unit/fixtures/classification-<version>.json` (`mutation`, `irreversible`, `sensitive`, `bodyRules`), so a change to either is a reviewed diff. Without a rule, GET and HEAD read, every other method mutates, and `DELETE` is irreversible.

- **Reads that are POSTs**: client-description and identity-provider certificate conversion, authorization policy and permission evaluation, client certificate download (still withheld as a sensitive response) and partial realm export change nothing and run through `keycloak_read`.
- **Irreversible whatever the body**: existing-resource `DELETE` operations; bodyless association `PUT` operations with a matching `DELETE` route; logouts, session removal and impersonation; password resets, credential changes other than a label, and clearing brute-force lockouts; sent email (test email included) and organization invitations; client-secret and registration-access-token regeneration; client certificate and key generation and upload, which drop the stored private key; `partialImport` and authorization-settings import; cache eviction; not-before pushes; triggering or migrating Keycloak workflows; fetching identity-provider metadata from a supplied URL; and the GET endpoints that reload identity-provider keys or make Keycloak contact a client's registered cluster nodes (`test-nodes-available`).
- **Irreversible because of the body**: preflight judges the JSON a step sends (its `body`, or its `bodyBase64` decoded as Keycloak decodes JSON: UTF-8, UTF-16 or UTF-32, with or without a byte-order mark) against the body rules, and a step that triggers one needs the override like any irreversible step; the refusal names each rule, for example `[sets-credentials]`. A body is judged alone, without reading Keycloak's current state, so a field that could change something counts as changing it: send only the fields an update changes. Values count as Keycloak's JSON reader coerces them: `"false"`, `"FALSE"` or `0` turns a flag off like `false`, `"true"` or `1` turns it on like `true`, a numeric string sets a number, and a value Keycloak would reject counts as the one a rule guards against. The rules are:
  - `sets-secret`: any `PUT` or `PATCH` that sets a secret field (a client secret, a registration access token, a private-key or rotated-secret attribute, a key in `KEYCLOAK_MCP_SECRET_ATTRIBUTES`, private JSON Web Key members, an LDAP, identity-provider, key-provider or reCAPTCHA secret, or a private key anywhere). Keycloak's own mask `**********` sets nothing in a `config` map, which keeps the stored value for it; a client `secret` sent as the mask is stored as the mask.
  - `sets-credentials`, `links-federation`, `unlocks-user`: a user update with `credentials`, with a `federationLink` (a user whose link a provider does not validate can be deleted on its next read), or with `enabled: true` (which clears a brute-force lockout; leave `enabled` out unless you mean to unlock).
  - `drops-authorization`, `disables-service-account`: a client update that does not set `authorizationServicesEnabled: true`, leaving it out included, or that makes the client public or bearer-only, deletes the client's authorization settings; `serviceAccountsEnabled: false` deletes the service-account user. A client update is therefore reversible only when it carries `authorizationServicesEnabled: true`, so updating a client without authorization services needs the override.
  - `renames-realm`, `renames-role`, `renames-required-action`: a new realm name, role name or required-action alias (a required-action body without its alias clears it).
  - `moves-not-before`, `replaces-smtp`, `stops-realm-events`: a realm update that sets `notBefore`, sends `smtpServer` (the stored SMTP password is dropped unless masked with an unchanged destination), or turns off or narrows event recording (`eventsEnabled`, `adminEventsEnabled` or `adminEventsDetailsEnabled` false, `eventsListeners`, `enabledEventTypes`) or sets a positive `eventsExpiration` or `attributes.adminEventsExpiration`, which makes Keycloak delete older events or admin events.
  - `stops-events`: the same for `PUT .../events/config`, where a missing `eventsEnabled` turns user events off; send `eventsEnabled: true` to keep them.
  - `repoints-federation`, `regenerates-keys`: a component config with `connectionUrl`, `bindDn`, `scimurl` or `loginusername` (the stored bind credential goes to the new address on the next user search), or with a key size or curve (a generated key provider makes a new key).
  - `drops-idp-secret`, `repoints-idp-secret`: an identity-provider update whose `config` leaves out `clientSecret`, or sends it null or empty, deletes the stored secret, whatever the body's `providerId`: Keycloak keeps the stored provider type and applies the body's config to it. Sending `clientSecret: "**********"` keeps the stored secret, and Keycloak accepts it for a SAML or other provider that has none. An update that names `tokenUrl` or `tokenIntrospectionUrl` while its masked `clientSecret` keeps the stored secret sends that secret there. Since the config map is replaced whole, an OAuth 2.0 or OpenID Connect provider update that keeps its token endpoint triggers one rule or the other and needs the override.
  - `disables-admin-permissions`: a fine-grained admin-permissions (version 1) `PUT` without `enabled: true`, which deletes the permissions.
  - `moves-group`: a group create whose body names an existing `id`, which Keycloak moves instead of creating a group.
  - `unreadable-body`: for any operation above, a `bodyBase64` body sent as JSON that is not valid text in its encoding or not exactly one JSON document. Keycloak may still read it, since it decodes overlong UTF-8 and ignores what follows the first document, so the other rules cannot vouch for it.
- **Operations only the Java admin client reaches** (`nightly`): each route has its own rule in `ADMIN_CLIENT_ROUTES`. Typed authorization policy and permission reads, verifiable-credential listings and server information are reads. Typed policy and permission creates and updates and verifiable-credential grants are reversible mutations. Their deletes, verifiable-credential refreshes, offers and revocations, cache clears, LDAP connection and capability tests (Keycloak connects and binds to the host the body names) and user-storage synchronization, unlinking and removal of imported users are irreversible. An admin-client operation that no rule covers counts as an irreversible mutation with a withheld response.
- **Extension routes** declare `readOnly` and `irreversible` themselves; an extension mutation by GET or HEAD cannot declare a compensation, because no rule could check it, and runs only as an irreversible step.

Some effects keep their classification and are documented instead. A read of users in a realm with user federation contacts the directory, can import users into Keycloak, and can delete a user whose federation link no longer validates. Creating a Keycloak workflow schedules actions on existing resources, which the compensating delete does not undo once they have run. An authorization resource create that names scopes which do not exist creates them, and deleting the resource leaves them. An authenticator-config update replaces the whole config map, so a secret left out of it is removed; its body does not say which authenticator it configures, so no rule can tell whether it drops one: send the secret back as the `**********` Keycloak returned.

Keycloak Admin REST does not expose a transaction spanning multiple HTTP requests. Compensations are best effort and cannot recreate deleted sessions, sent mail, rotated secrets, external side effects, or every prior representation. Known irreversible operations and bodies are blocked by default. An operator can also classify any mutation as irreversible. To run either case, set `KEYCLOAK_MCP_ALLOW_IRREVERSIBLE=true` and mark that step `irreversible=true`; a later failure returns `IN_DOUBT` even if other steps compensate. The catalog still describes every operation. The [Keycloak guide](https://www.keycloak.org/docs/latest/server_admin/) explains service-account roles and permissions.

## Verification

`npm run check` covers catalog uniqueness and route construction for all 413 `latest` and 374 versioned operations, token exchange, realm pinning, redaction, fail-closed preflight for every state-changing mutation of both catalogs, each operation's reviewed classification (`test/unit/fixtures/classification-<version>.json`), compensation, receipt states, OpenClaw tool registration and manifest contracts, and private plugin config selection. The [validation record](docs/validation-history/2026-09/VALIDATION.md) distinguishes 26.3.5 deployed-version evidence from the isolated 26.7.4 [413-route ledger](docs/validation-history/2026-09/validation/latest-26.7.4-route-ledger.json). Each latest method/path key has at least one successful service-account call with a valid fixture across default, explicitly enabled feature, or storage-backed configurations; this is route-level evidence with the limits described in the ledger. `npm run live:soak` is opt-in and requires `KEYCLOAK_MCP_LIVE_SOAK=true`, `KEYCLOAK_MCP_SOAK_CREDENTIALS`, and a realm whose name begins `keycloak-mcp-soak-`. It runs real reads and reversible workflow cycles; use a disposable realm and verify its cleanup separately. `npm run live:coverage` uses a disposable realm to execute safe GET operations and writes a per-operation report to `KEYCLOAK_MCP_COVERAGE_OUT` when `KEYCLOAK_MCP_LIVE_COVERAGE=true`. Set `KEYCLOAK_MCP_COVERAGE_FIXTURES=true` to create one group through a compensated workflow and exercise more path-based reads; this requires a disposable realm with write-capable test credentials and a separate realm cleanup step. `npm run live:openclaw` requires `KEYCLOAK_MCP_LIVE_OPENCLAW=true`, an OpenClaw CLI, a disposable loopback Keycloak, and `KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP` naming a `0600` JSON file with that server's bootstrap administrator. It installs the packed tarball into a throwaway OpenClaw home, calls the five tools through a local Gateway, runs one compensated write in a realm it creates and deletes, and writes a receipt to `KEYCLOAK_MCP_OPENCLAW_OUT`.

The `latest` and 26.3.5 definitions overlap on 372 exact method/path keys; 41 appear only in `latest`, and two 26.3.5 keys use an older path-parameter name. The catalog proves addressability of the selected documented operations. The 26.3.5 OpenAPI entry for federated identity creation omits the JSON body consumed by [Keycloak's implementation](https://github.com/keycloak/keycloak/blob/26.3.5/services/src/main/java/org/keycloak/services/resources/admin/UserResource.java). Both bundled OpenAPI versions also omit the multipart body consumed by [certificate upload](https://github.com/keycloak/keycloak/blob/26.3.5/services/src/main/java/org/keycloak/services/resources/admin/ClientAttributeCertificateResource.java). The runtime corrects these exact request descriptions without changing the pinned source. On disposable containers of the deployed 26.3.5 image, valid-fixture calls succeeded for **185 of 185** action routes across default and explicitly enabled preview/experimental feature configurations (184 state-changing routes plus the read-only converter). The default-feature aggregate is 175 of 185. `disable-credential-types` returned HTTP 204 without effect on local OTP credentials, then passed against a storage-backed user with a backing-store readback. [Keycloak's 26.3.5 admin-client source](https://github.com/keycloak/keycloak/blob/26.3.5/integration/admin-client/src/main/java/org/keycloak/admin/client/resource/UserResource.java) says this action is typically supported for users backed by a user storage provider. These route-level calls do not prove that every payload, read route, role assignment, server feature, or rollback behaves correctly, or that the tested preview features are enabled in production. The versioned source hash and live results should be recorded for each release. See [VALIDATION.md](docs/validation-history/2026-09/VALIDATION.md) for the executed coverage and remaining gaps.
