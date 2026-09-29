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
| `MutationEquivalenceIT` | F2 | Every mutation case (see [Mutation families](#mutation-families)) runs through `keycloak_workflow` in one realm and through the reference in its twin: the admin client's typed binding when it has one, else raw HTTP. Both must answer in the same status class and leave the same state, read back raw and compared with generated ids replaced by natural keys. Only a case that both sides performed (2xx) shows the operation `EQUIVALENT`. A case that both sides rejected alike is `REJECTED_ALIKE`: it is accepted but proves nothing, and an operation with no performed case is `ROUTED_ONLY`. |
| | F3 | When keycloak-mcp accepts a case's compensation as reversible, a third twin runs the operation followed by a step that always fails. The frame is `SOUND` only when all of these hold: the operation completed with a 2xx, the forced step is the one that failed, the rollback holds exactly the declared compensation as `COMPENSATED`, and the state equals the state before. A frame whose operation itself failed and left the state as it was is `NOT_EXERCISED`: it is accepted but proves nothing, and an operation is `SOUND` only with an exercised frame. If that failed operation changed the state anyway, the server committed a write that keycloak-mcp neither reported completed nor compensated, and the frame is `UNSOUND`. A case the family marks irreversible must be refused without the override; accepting it is a misclassification, and the frame's result is its counterexample. |
| `SafetySemanticsIT` | F4 | keycloak-mcp's own guarantees against the live server: realm pinning (a `path.realm` override, encoded traversal, reads without `{realm}`), write gating, irreversible gating (also for secrets set through a representation PUT), redaction on and off against raw HTTP (on both as keycloak-mcp ships it, with `KEYCLOAK_MCP_ALLOW_SENSITIVE_READS` unset, and with the switch set to `false`), a redacted value PUT back with the irreversible override in use (so only rejecting or stripping the redaction marker can keep the secret), compensation after a failed step with `IN_DOUBT` and `failedStepMayHaveCommitted`, `$step.locationId` and `$step.responseId` binding, journal receipts, and a clean exit. keycloak-mcp reaches the server through a recording proxy, so every refusal is shown to send nothing, and the realm's admin events show that nothing changed. |
| `LedgerCompletenessIT` | ledger | Runs last. Every reference operation ends in one verdict: `EQUIVALENT`, `ROUTED_ONLY` (with the reason) or `DIVERGENT_DOCUMENTED` (with the entries). It fails on any operation a check refused, grouped by cause. When a functional check was not selected for the run, it is aborted and names the missing check. |

F1 reads one realm seeded with at least one entity of every kind the admin API reads: clients of every access type, composite roles, groups, a user with credentials, consents and sessions, identity providers and mappers, components (keys, a disabled LDAP), a configured flow, an organization with an invitation, client policies, localization, events, a workflow, and a policy of every type the admin client can create. Path variables are bound by position (`PathValues`); searches and read-only POSTs get their arguments from `ReadRequests`. keycloak-mcp's read/mutation classification is taken from a dry-run `keycloak_workflow`, which never sends a request. Because every read is also sent raw with a master-admin token, the classification fails closed. A catalog operation is a read only when the dry run, given the read's own arguments, answers `PREFLIGHT_OK`. It is a mutation, left to F2, only when the dry run refuses it with `writes are disabled`. Any other answer fails that operation as `CLASSIFICATION_UNKNOWN`, and nothing is sent for it. F1 sends nothing at all unless `DELETE /admin/realms/{realm}` still classifies as a mutation and `GET /admin/realms/{realm}` as a read. A GET or HEAD the catalog lacks is a read by its method.

Each read is judged against a reference that held still: raw HTTP is read immediately before and after the subject, and a reference that changed is read again. Values that legitimately change between identical reads are listed per operation in `src/test/resources/read-volatility.json` and masked on every side.

Every verdict and the run's provenance go to `target/equivalence-ledger.json`. Provenance covers:

- the git SHA and the image digest
- the server version and its enabled features
- the resolved admin-client snapshot, with its jar SHA-256 and `Scm-Revision`
- the OpenAPI SHA-256 and the catalog version

## Mutation families

F2 owns every reference operation keycloak-mcp classifies as a mutation (a dry run with writes off refuses it with `writes are disabled`), and every non-GET operation its catalog lacks. An operation gets its `F2:mutation` verdict from its cases, and its `F3:compensation` outcome with it. An operation without a case is `ROUTED_ONLY` ("no mutation case") until a family covers it. `target/mutation-coverage.json` lists those operations, the operations each family covers, and any case for an operation F2 does not own.

Cases live in `src/main/java/.../mutations/*Family.java`. Each case runs in fresh twin realms (`equivalence-f2-<family>-<run>-<n>-a`, `-b`, and `-c` for the F3 frame), which are deleted afterwards. keycloak-mcp runs them with `KEYCLOAK_MCP_ALLOW_WRITE`, `KEYCLOAK_MCP_SINGLE_WRITER` and `KEYCLOAK_MCP_ALLOW_IRREVERSIBLE`.

To add a family:

1. Implement `MutationFamily`. `name()` becomes part of realm names (`[a-z0-9-]+`). `seed(realm)` creates the baseline every twin starts from, through `CaseContext.create`, `send` and `get`, which are raw JSON requests below `/admin/realms/{realm}/`.
2. Write one `MutationCase` per operation and body shape. Use `MutationCase.of(operation, name)`, where `operation` is the reference key with the OpenAPI variable names, and then:
   - `setup(realm)`: extra state the case needs on top of the seed.
   - `args(realm)`: `CaseArgs.path(realm.realm(), ...)` gives the path values by position, the realm's included, then `withQuery` and `withBody`. Address entities by natural key (`realm.id(NaturalKeys.group("/a/b"))`), never by an id seen in another realm.
   - `compensatedBy(realm)`: the undo keycloak-mcp should accept, resolved before the mutation. It may use `$step.locationId` or `$step.responseId`. A reversible case must name one.
   - `readback(...)`: GETs that observe what the operation changes. They are resolved before the mutation and read raw. Use `Readback.unordered` only when the server returns a set, and cite the server source that leaves it unordered.
   - `volatileField(readback, path, reason)`: a value that legitimately differs between twins in the same state, with a reason.
   - `reversible(why)` or `irreversible(why)`: what keycloak-mcp must do with it, with a server `file:line`. An irreversible case must be refused unless the irreversible override is used. A reversible case that keycloak-mcp accepts must restore the pre-state after a forced failure. A reversible case keycloak-mcp will not compensate is accepted as `NOT_COMPENSABLE` and runs with the override. Give every operation at least one case that the server performs. A case the server rejects (a name conflict, a bad body, wrong arguments) ends `REJECTED_ALIKE` and `NOT_EXERCISED`, so on its own it leaves the operation `ROUTED_ONLY`.
   - `requires("<finding id>")`: add this only when the correct behavior needs a keycloak-mcp fix that is not in yet. Such cases run in the `requires-node-fixes` factory and fail until the fix lands.
3. Add the family to `MutationFamilies.all()`.
4. `NaturalKeys.index` maps ids to natural keys for the realm itself, realm roles, clients, client roles, users and groups. If a readback shows ids of another kind, index that kind there, or the twins will differ.
5. Run `mvn -B test` (it includes `MutationFamiliesTest`), then `mvn -B verify -Dit.test=MutationEquivalenceIT`. The coverage count in the log goes up.

## Checks awaiting keycloak-mcp fixes

Some checks assert behavior that keycloak-mcp gets right only once a verified finding (for example `SEC-1`) is fixed. They carry `@RequiresNodeFixes({...})`, or run in `MutationEquivalenceIT#casesAwaitingNodeFixes`; both carry the JUnit tag `requires-node-fixes`. They are never disabled: against a keycloak-mcp without the fixes they fail and name the finding. `-DexcludedGroups=requires-node-fixes` leaves them out of a run. Leaving them out also leaves the operations they cover without a complete F2 verdict, so those operations are reported as unaccounted.

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
mvn -B verify -Dit.test='SafetySemanticsIT,MutationEquivalenceIT'   # F4, F2 and F3 only
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

Each run creates a confidential service-account client in `master` (`equivalence-<hex>`) and realms for the live checks: `equivalence-s3-<millis>`, `equivalence-f1-<millis>`, `equivalence-f4-<millis>` (and `-other`), and twin realms per mutation case. All of them are removed when their check ends. Seeded realms send mail to an SMTP sink in the test JVM, which accepts and discards it: an organization invitation only exists once its mail went out.
