# keycloak-mcp equivalence suite

Java 21 / Maven module that checks keycloak-mcp against Keycloak HEAD. It uses three oracles, listed from most to least authoritative:

1. **The live server** (`quay.io/keycloak/keycloak:nightly`), reached over raw HTTP with the same service-account token keycloak-mcp uses.
2. **The Java admin client** `org.keycloak:keycloak-admin-client:999.0.0-SNAPSHOT`. Its JAX-RS surface is walked by reflection.
3. **The HEAD OpenAPI definition** (`https://www.keycloak.org/docs-api/nightly/rest-api/openapi.json`). If that URL is unreachable, the suite falls back to `../data/openapi-nightly.json` and logs a warning.

keycloak-mcp itself is only observed through MCP stdio: `node ../src/index.js`, started with a private config file and journal directory.

## Checks

| IT | Check | Obligation |
|---|---|---|
| `StructuralEquivalenceIT` | S1 | The catalog, read through `keycloak_search_operations` and `keycloak_describe_operation`, lists exactly HEAD OpenAPI ∪ admin-client operations. It describes each one as its source does. |
| | S2 | Each catalog operation declares every path variable once. OpenAPI and the admin client agree on query parameters, form fields and media types. |
| | S3 | The live server routes every catalog and reference operation in a seeded, disposable realm. A 2xx proves routing. A specific error proves it only if the same request one segment deeper does not get the same answer; if it does, a sub-resource locator on the path answered (`INCONCLUSIVE`), and the operation needs a seeded entity or a documented gate. |
| `ReadEquivalenceIT` | F1 | Every read (each GET, and each operation keycloak-mcp itself classifies as read-only) answers the same through `keycloak_read` as over raw HTTP with the same token and `Accept`: status, content class, value; only key order may differ and numbers must match exactly. Where the admin client has the operation, its typed result matches raw HTTP too, up to the dated known-lag list. One dynamic test per read. |
| `LedgerCompletenessIT` | ledger | Runs last. Every reference operation ends in one verdict: `EQUIVALENT`, `ROUTED_ONLY` (with the reason) or `DIVERGENT_DOCUMENTED` (with the entries). It fails on any operation a check refused, grouped by cause. When a functional check was not selected for the run, it is aborted and names the missing check. |

F1 reads one realm seeded with at least one entity of every kind the admin API reads: clients of every access type, composite roles, groups, a user with credentials, consents and sessions, identity providers and mappers, components (keys, a disabled LDAP), a configured flow, an organization with an invitation, client policies, localization, events, a workflow, and a policy of every type the admin client can create. Path variables are bound by position (`PathValues`); searches and read-only POSTs get their arguments from `ReadRequests`. keycloak-mcp's read/mutation classification is taken from a dry-run `keycloak_workflow`, which never sends a request; mutations are left to F2.

Each read is judged against a reference that held still: raw HTTP is read immediately before and after the subject, and a reference that changed is read again. Values that legitimately change between identical reads are listed per operation in `src/test/resources/read-volatility.json` and masked on every side.

Every verdict and the run's provenance go to `target/equivalence-ledger.json`. Provenance covers:

- the git SHA and the image digest
- the server version and its enabled features
- the resolved admin-client snapshot, with its jar SHA-256 and `Scm-Revision`
- the OpenAPI SHA-256 and the catalog version

## Documented divergences

Sources may disagree only through `src/test/resources/divergences.json`. Each entry pins the exact observation and carries a reason, evidence (a server source `file:line` where possible) and a `since` date.

- **Undocumented observations** fail the check. The failure message prints a ready-to-complete entry.
- **Entries that no longer match anything** are stale and also fail. The exceptions are `route` and `read-gate` entries (sources `server`): the server refuses the operation for lack of a feature or provider, and a different feature profile legitimately lifts the gate. F1 reports a documented `read-gate` as `ROUTED_ONLY` with its reason.

The admin client trails HEAD, so its typed reads may differ from raw HTTP only as `src/test/resources/admin-client-known-lag.json` records: one entry per operation, JSON path and difference kind, with a reason, evidence and the date it was first seen. Array order is not compared where the adapter's own model holds the array in a `Set`. Known-lag and volatility entries that explain nothing in a full run are stale and fail.

## Running

```sh
mvn -B test                                    # unit tests, no Docker
mvn -B verify                                  # + ITs on a Testcontainers Keycloak (Docker required)
mvn -B verify -Dkeycloak.url=http://127.0.0.1:18080   # + ITs against a running server (dev loop)
mvn -B verify -Dit.test='ReadEquivalenceIT,LedgerCompletenessIT'   # F1 and the ledger check only
mvn -f equivalence/pom.xml -Psupplement        # regenerate ../data/admin-client-supplement-nightly.json
```

| Property | Default | Meaning |
|---|---|---|
| `keycloak.image` | `quay.io/keycloak/keycloak:nightly` | Image started by Testcontainers |
| `keycloak.features` | `preview,client-types,admin-fine-grained-authz:v1` | `--features` for that container; empty keeps the server defaults. The default reaches the most reference operations (see the pom). `admin-fine-grained-authz:v1` replaces the default v2: they are versions of one feature, and only v1 serves the `management/permissions` operations. |
| `keycloak.url` | unset | Attach to this server instead of starting a container; its features are whatever it runs, and the ledger records them |
| `keycloak.callback.host` | `172.17.0.1` | Where a `keycloak.url` server reaches this JVM, for the SMTP sink; Docker's bridge gateway suits a server started with `-p`. A container uses Testcontainers' host alias |
| `keycloak.admin.user` / `keycloak.admin.password` | `admin` / `admin` | Bootstrap admin, used only to create the service account |
| `keycloakmcp.root` | `..` | keycloak-mcp checkout to spawn |
| `keycloakmcp.catalog` | `nightly` | `KEYCLOAK_MCP_CATALOG_VERSION` under test |
| `node.executable` | `node` | Node.js binary |

Each run creates a confidential service-account client in `master` (`equivalence-<hex>`) and one realm per live check (`equivalence-s3-<millis>`, `equivalence-f1-<millis>`). Both are removed when the run ends. Seeded realms send mail to an SMTP sink in the test JVM, which accepts and discards it: an organization invitation only exists once its mail went out.
