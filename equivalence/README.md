# keycloak-mcp equivalence suite

Java 21 / Maven module that checks keycloak-mcp against Keycloak HEAD. It uses three oracles, listed from most to least authoritative:

1. **The live server** (`quay.io/keycloak/keycloak:nightly`), reached over raw HTTP with the same service-account token keycloak-mcp uses.
2. **The Java admin client** `org.keycloak:keycloak-admin-client:999.0.0-SNAPSHOT`. Its JAX-RS surface is walked by reflection.
3. **The HEAD OpenAPI definition** (`https://www.keycloak.org/docs-api/nightly/rest-api/openapi.json`). If that URL is unreachable, the suite falls back to `../data/openapi-nightly.json` and logs a warning.

keycloak-mcp itself is only observed through MCP stdio: `node ../src/index.js`, started with a private config file and journal directory.

## Checks

`StructuralEquivalenceIT` runs these checks:

| Check | Obligation |
|---|---|
| S1 | The catalog, read through `keycloak_search_operations` and `keycloak_describe_operation`, lists exactly HEAD OpenAPI ∪ admin-client operations. It describes each one as its source does. |
| S2 | Each catalog operation declares every path variable once. OpenAPI and the admin client agree on query parameters, form fields and media types. |
| S3 | The live server routes every catalog and reference operation in a seeded, disposable realm. |

Every verdict and the run's provenance go to `target/equivalence-ledger.json`. Provenance covers:

- the git SHA and the image digest
- the server version
- the resolved admin-client snapshot, with its jar SHA-256 and `Scm-Revision`
- the OpenAPI SHA-256 and the catalog version

## Documented divergences

Sources may disagree only through `src/test/resources/divergences.json`. Each entry pins the exact observation and carries a reason, evidence (a server source `file:line` where possible) and a `since` date.

- **Undocumented observations** fail the check. The failure message prints a ready-to-complete entry.
- **Entries that no longer match anything** are stale and also fail. The exception is `route` entries: enabling a feature may legitimately lift a gate.

## Running

```sh
mvn -B test                                    # unit tests, no Docker
mvn -B verify                                  # + ITs on a Testcontainers Keycloak (Docker required)
mvn -B verify -Dkeycloak.url=http://127.0.0.1:18080   # + ITs against a running server (dev loop)
mvn -f equivalence/pom.xml -Psupplement        # regenerate ../data/admin-client-supplement-nightly.json
```

| Property | Default | Meaning |
|---|---|---|
| `keycloak.image` | `quay.io/keycloak/keycloak:nightly` | Image started by Testcontainers |
| `keycloak.features` | server defaults | `--features` for that container |
| `keycloak.url` | unset | Attach to this server instead of starting a container |
| `keycloak.admin.user` / `keycloak.admin.password` | `admin` / `admin` | Bootstrap admin, used only to create the service account |
| `keycloakmcp.root` | `..` | keycloak-mcp checkout to spawn |
| `keycloakmcp.catalog` | `nightly` | `KEYCLOAK_MCP_CATALOG_VERSION` under test |
| `node.executable` | `node` | Node.js binary |

Each run creates a confidential service-account client in `master` (`equivalence-<hex>`) and one realm per live check (`equivalence-s3-<millis>`). Both are removed when the run ends.
