# keycloak-mcp

A standalone Keycloak Admin REST interface for Claude Code, Codex, OpenClaw, and JavaScript callers. It uses **OAuth 2.0 client credentials only**. No user password, browser login, or operator token is accepted by the runtime.

The pinned `latest` catalog represents all **413 method/path operations across 273 paths** in the [official Keycloak Admin REST OpenAPI definition](https://www.keycloak.org/docs-api/latest/rest-api/index.html) downloaded on 2026-09-26. A second bundled catalog covers the [Keycloak 26.3.5 Admin REST definition](https://www.keycloak.org/docs-api/26.3.5/rest-api/openapi.json) with 374 operations. Set `KEYCLOAK_MCP_CATALOG_VERSION=26.3.5` for a 26.3.5 server; the default is `latest`. Search and describe tools make the selected surface usable without placing hundreds of tools in an LLM context. `npm run catalog:update` regenerates both catalogs from upstream; review their diffs and rerun checks before release. Installed SPI routes can be added through a private, deployment-specific catalog; they are not part of Keycloak's official Admin REST specification.

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
| `keycloak_read` | Call a read-only catalog operation with the configured service account and realm, including GET, client-description conversion, and identity-provider certificate conversion. |
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

For a `POST` that returns a `Location` ending in its new resource ID, a compensation path parameter can use `"$step.locationId"`. Some Keycloak creates, including authorization resources and scopes, return a JSON `id` or `_id` without `Location`; use `"$step.responseId"` for a generated UUID in that response. The runtime accepts one binding only for a `DELETE` of that collection's direct child, checks any Location against the configured Keycloak origin and response ID, and records the resolved path in the private workflow receipt. A missing or conflicting ID leaves the write `IN_DOUBT` for manual reconciliation.

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

The lock is per Keycloak base URL and realm. It does not fence external Keycloak administrators or unrelated clients. The PostgreSQL lock is a session-level advisory lock, so connect directly or through session pooling; PgBouncer transaction pooling cannot hold it. The connection is checked before each step and before each compensation. If it drops (an `idle_session_timeout`, a failover), the server has released the lock, so the run stops with `lost the PostgreSQL lock connection` and ends `IN_DOUBT` without compensating, because another workflow may already hold the realm. A local file receipt is written before and after each step under `KEYCLOAK_MCP_JOURNAL_DIR` (default `~/.local/state/keycloak-mcp`). The receipt includes operation keys and path parameters, but omits request bodies and query values; restrict access to it because path parameters can identify users or clients. A crash, timeout, lost lock, or 5xx can leave the current step **in doubt** even when prior steps were compensated. On an operation error, the result is `IN_DOUBT`; `failedStepMayHaveCommitted` is false for a read-only failed step and for a step whose request was never sent (its lock check, its in-flight receipt or the token grant failed first), and `priorStepsCompensated` reports only whether earlier compensation calls succeeded. Read back affected resources and reconcile using the receipt's `runId`.

Existing-resource `DELETE` operations, bodyless association `PUT` operations with a matching `DELETE` route, credential-type disablement, and known external actions require the explicit irreversible override. External actions include sending or resending organization invitations, triggering or migrating Keycloak workflows, and fetching identity-provider metadata from a supplied URL; these effects cannot be undone by a Keycloak compensation. Disabling a stored credential cannot generally restore its prior secret. Preflight permits an otherwise irreversible compensation when it deletes the realm just created by the matching global create step, deletes a direct child using that create response's generated ID, or deletes a newly created realm role or identity-provider instance using the exact nonblank name or alias in the create body. The named exception is limited to those two create routes. A `POST` mutation can compensate only with a `DELETE` of its created direct child, keeping the same parent path; an ID or UUID path parameter must use `$step.locationId` or `$step.responseId`, not a caller-supplied ID. A representation update compensation must use `PUT` or `PATCH` on the same route, path parameters, and query. Repeating an association `PUT` cannot undo the association; a `DELETE` may remove a pre-existing association, so these operations require the irreversible override until prior state can be proved. Other compensation bodies remain caller-declared, so preflight cannot establish that they restore prior state. Role-mapping additions require an explicit irreversible override because deleting the mapping could remove a role that was already assigned before the workflow. A successful create and compensating DELETE still require readback to establish the final state, and the lock does not fence other Keycloak writers.

Read-only operations retry HTTP 502, 503, and 504 at most twice with short delays and return an `attempts` count when a retry occurs. A safe GET also refreshes an invalidated service-account token and retries once after HTTP 401. A successful `logout-all` clears the cached token. Mutations, including side-effecting GET operations, are never retried automatically because a failed response may follow a committed change. A failed call reports the HTTP status, the number of attempts and Keycloak's own error text (`error`, `errorMessage` or `error_description`), cut to 300 characters and redacted like a response. A redirect is reported with its status and never followed.

Operations outside the configured realm, including reads such as `GET /admin/realms` that return every realm the service account can see, are blocked unless `KEYCLOAK_MCP_ALLOW_REALM_ADMIN=true`. A GET endpoint that reloads identity-provider keys is treated as a mutation. The client-description converter POST is treated as a read after exact-version source and live response checks. The runtime rejects arbitrary URLs, unknown operation keys, undeclared query and content types, path traversal, redirects, and direct mutation calls through `keycloak_read`. Secret fields of Keycloak representations, private JSON Web Key members (as in a client's `jwks.string`) and private keys in any string, whether PEM or the base64 DER without a header that Keycloak writes, client initial-access tokens, detailed admin-event representations, client certificate info and keystore downloads, installation exports, generated examples, and known secret endpoints are redacted unless `KEYCLOAK_MCP_ALLOW_SENSITIVE_READS=true`. The secret fields are listed, with the Keycloak source that makes each one secret, in `src/policy/table.js`: client secrets, rotated secrets, private-key attributes and registration access tokens, which Keycloak returns in clear to a client manager, the private key of an uploaded keystore, and the SMTP, identity-provider, LDAP, key-provider, reCAPTCHA and credential secrets that Keycloak masks as `**********`. Every other field, and Keycloak's own mask, is returned as sent. Keycloak cannot know which custom attribute holds a secret and returns them all in clear; list such keys in `KEYCLOAK_MCP_SECRET_ATTRIBUTES` (comma-separated, or a JSON list in the config file) to redact them in every `attributes` and `config` map. A redacted value reads `[REDACTED by keycloak-mcp]` (or `[REDACTED by keycloak-mcp: sensitive endpoint]` for a withheld response). Keycloak would store such text as the real value, so any request whose path, query or body contains it is refused before it is sent: leave redacted fields out of an update, which keeps the stored secret.

Keycloak Admin REST does not expose a transaction spanning multiple HTTP requests. Compensations are best effort and cannot recreate deleted sessions, sent mail, rotated secrets, external side effects, or every prior representation. Known irreversible operations are blocked by default. An operator can also classify any mutation as irreversible. To run either case, set `KEYCLOAK_MCP_ALLOW_IRREVERSIBLE=true` and mark that step `irreversible=true`; a later failure returns `IN_DOUBT` even if other steps compensate. The catalog still describes every operation. The [Keycloak guide](https://www.keycloak.org/docs/latest/server_admin/) explains service-account roles and permissions.

## Verification

`npm run check` covers catalog uniqueness and route construction for all 413 `latest` and 374 versioned operations, token exchange, realm pinning, redaction, fail-closed preflight for all 202 latest and 184 versioned state-changing mutations, compensation, receipt states, OpenClaw tool registration and manifest contracts, and private plugin config selection. The [validation record](docs/validation-history/2026-09/VALIDATION.md) distinguishes 26.3.5 deployed-version evidence from the isolated 26.7.4 [413-route ledger](docs/validation-history/2026-09/validation/latest-26.7.4-route-ledger.json). Each latest method/path key has at least one successful service-account call with a valid fixture across default, explicitly enabled feature, or storage-backed configurations; this is route-level evidence with the limits described in the ledger. `npm run live:soak` is opt-in and requires `KEYCLOAK_MCP_LIVE_SOAK=true`, `KEYCLOAK_MCP_SOAK_CREDENTIALS`, and a realm whose name begins `keycloak-mcp-soak-`. It runs real reads and reversible workflow cycles; use a disposable realm and verify its cleanup separately. `npm run live:coverage` uses a disposable realm to execute safe GET operations and writes a per-operation report to `KEYCLOAK_MCP_COVERAGE_OUT` when `KEYCLOAK_MCP_LIVE_COVERAGE=true`. Set `KEYCLOAK_MCP_COVERAGE_FIXTURES=true` to create one group through a compensated workflow and exercise more path-based reads; this requires a disposable realm with write-capable test credentials and a separate realm cleanup step. `npm run live:openclaw` requires `KEYCLOAK_MCP_LIVE_OPENCLAW=true`, an OpenClaw CLI, a disposable loopback Keycloak, and `KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP` naming a `0600` JSON file with that server's bootstrap administrator. It installs the packed tarball into a throwaway OpenClaw home, calls the five tools through a local Gateway, runs one compensated write in a realm it creates and deletes, and writes a receipt to `KEYCLOAK_MCP_OPENCLAW_OUT`.

The `latest` and 26.3.5 definitions overlap on 372 exact method/path keys; 41 appear only in `latest`, and two 26.3.5 keys use an older path-parameter name. The catalog proves addressability of the selected documented operations. The 26.3.5 OpenAPI entry for federated identity creation omits the JSON body consumed by [Keycloak's implementation](https://github.com/keycloak/keycloak/blob/26.3.5/services/src/main/java/org/keycloak/services/resources/admin/UserResource.java). Both bundled OpenAPI versions also omit the multipart body consumed by [certificate upload](https://github.com/keycloak/keycloak/blob/26.3.5/services/src/main/java/org/keycloak/services/resources/admin/ClientAttributeCertificateResource.java). The runtime corrects these exact request descriptions without changing the pinned source. On disposable containers of the deployed 26.3.5 image, valid-fixture calls succeeded for **185 of 185** action routes across default and explicitly enabled preview/experimental feature configurations (184 state-changing routes plus the read-only converter). The default-feature aggregate is 175 of 185. `disable-credential-types` returned HTTP 204 without effect on local OTP credentials, then passed against a storage-backed user with a backing-store readback. [Keycloak's 26.3.5 admin-client source](https://github.com/keycloak/keycloak/blob/26.3.5/integration/admin-client/src/main/java/org/keycloak/admin/client/resource/UserResource.java) says this action is typically supported for users backed by a user storage provider. These route-level calls do not prove that every payload, read route, role assignment, server feature, or rollback behaves correctly, or that the tested preview features are enabled in production. The versioned source hash and live results should be recorded for each release. See [VALIDATION.md](docs/validation-history/2026-09/VALIDATION.md) for the executed coverage and remaining gaps.
