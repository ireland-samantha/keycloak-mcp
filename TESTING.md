# Testing keycloak-mcp

keycloak-mcp is tested in four tiers. The first three run in every CI build and need only Node.js. The equivalence suite needs Java, Maven and Docker, and runs against a live Keycloak built from the main branch (HEAD).

| Tier | Command | Needs | Checks against |
| --- | --- | --- | --- |
| Unit | `npm run test:unit` | Node.js 22+ | fake `fetch` functions and the bundled catalogs |
| Golden masters | part of `npm run test:unit` | Node.js 22+ | recorded snapshots of current behaviour |
| Mock integration | `npm run test:mock` | Node.js 22+ | a loopback mock Keycloak serving responses recorded from Keycloak HEAD |
| Equivalence | `npm run test:equivalence` | Java 21, Maven, Docker | a live `quay.io/keycloak/keycloak:nightly`, the Java admin client, the HEAD OpenAPI definition |

`npm run check` runs `node --check` on every file under `src/`, `openclaw/` and `scripts/`, then the unit and mock tiers. CI (`.github/workflows/ci.yml`) runs it on Node.js 22 and 24, followed by `npm audit`. The equivalence suite is not part of that workflow.

## Unit

`test/unit/**/*.test.js` checks each module with fake `fetch` functions, private temporary files and injected clocks. The tests cover every operation of every bundled catalog (`latest`, `26.3.5` and `nightly`), listed in `test/support/catalog.js`:

- **Catalogs.** `catalog-contract.test.js` is the only test that states how many operations each bundled OpenAPI definition has. It checks that the operation list matches its definition, and that a bundled admin-client supplement was generated against that definition. Other tests check that every operation builds a request inside the configured origin, that each declared query parameter and body type builds, and that described parameters match the operation list.
- **Policy.** `classification.test.js` compares each operation's classification (`mutation`, `irreversible`, `sensitive`, body rules) with the reviewed fixture `test/unit/fixtures/classification-<version>.json`. `policy-table.test.js` requires every rule in `src/policy/table.js` and `src/catalog/corrections.js` to give a reason and a Keycloak source. `admin-client-routes.test.js` requires each of the operations that only the Java admin client reaches to have exactly one explicit rule. It uses the list from the surface sweep in `test/unit/fixtures/admin-client-only-ops.json`, which records its provenance. `body-rules.test.js` checks the body-dependent irreversibility rules.
- **Runtime.** These tests cover redaction (against the recorded HEAD responses in `test/mock/fixtures/keycloak-head.json`), token handling, transport and retries, response decoding, preflight, compensation, journals, locks, the supplement loader (with `test/unit/fixtures/admin-client-supplement.json`) and the parity of the MCP and OpenClaw adapters. `architecture.test.js` enforces the module layering.

**Proves:** the decisions keycloak-mcp makes and the requests it would send, for every bundled operation, and that the bundled data files agree with one another.

**Does not prove:** anything about how a real Keycloak answers.

## Golden masters

`test/unit/golden/` holds two snapshots. `snapshots/operations.json` records, for every operation of the `latest` and `26.3.5` catalogs, the described operation, its classification, the request it builds and the preflight result under five configurations. `snapshots/scenarios.json` records the results and journal receipts of reads and workflows against a fake Keycloak. A change to any row fails the test and names the changed rows.

To record an intended change, run the command below and commit the reviewed snapshot diff together with the change:

```sh
UPDATE_GOLDEN=1 node --test test/unit/golden/*.test.js test/unit/classification.test.js
```

**Proves:** that behaviour did not change without the diff being reviewed.

**Does not prove:** that the recorded behaviour is correct. `nightly` is left out on purpose: it follows Keycloak HEAD and changes with every catalog update, so its per-operation contract is its classification fixture.

## Mock integration

`test/mock/**/*.test.js` runs the real stdio server (`node src/index.js`) with a private `0600` configuration and a temporary journal directory, and speaks newline-delimited JSON-RPC to it (`test/support/mcp-stdio.js`). Some tests use an in-process server instead. Both talk to a loopback mock Keycloak (`test/support/mock-keycloak.js`), which provides:

- a token endpoint;
- programmable routes, with fault injection: status sequences, streamed and delayed bodies, responses held open, Location headers, and big-integer, YAML and binary bodies;
- default responses recorded from Keycloak HEAD. Their provenance, and how to record them again, are in `test/mock/fixtures/README.md`.

**Proves:** end-to-end behaviour through the MCP process and real HTTP:

- process start-up and exit codes;
- token caching and refresh;
- retries;
- realm pinning;
- write and irreversible gating, including that a refused call sends nothing to Keycloak;
- redaction;
- media types and body limits;
- workflow execution, compensation and receipts.

**Does not prove:** that Keycloak answers as a scenario programs the mock. The recorded bodies are real, but each test chooses its status sequences and faults, so a Keycloak behaviour that a scenario assumes needs its own evidence from a real server: the recording, or the equivalence suite.

The PostgreSQL lock scenarios run only when `KEYCLOAK_MCP_TEST_DATABASE_URL` names a disposable database reached as a superuser; otherwise they are skipped, and CI has no PostgreSQL.

## Equivalence with Keycloak HEAD

`equivalence/` is a Java 21 Maven module. It starts `quay.io/keycloak/keycloak:nightly` with Testcontainers, or attaches to a running server, and creates a service-account client. It then drives keycloak-mcp only through MCP stdio, with the `nightly` catalog. It measures keycloak-mcp against three oracles, in order of authority:

1. the live server, reached over raw HTTP with the same token;
2. the Java admin client `org.keycloak:keycloak-admin-client:999.0.0-SNAPSHOT`;
3. the HEAD OpenAPI definition.

| Check | What it asserts |
| --- | --- |
| S1 | The catalog, read through `keycloak_search_operations` and `keycloak_describe_operation`, lists exactly the HEAD OpenAPI operations plus those only the admin client reaches, and describes each as its source does. |
| S2 | Path parameters, query parameters and media types agree across the catalog and the oracles, except where `equivalence/src/test/resources/divergences.json` documents a difference with a reason and evidence. |
| S3 | The live server routes every operation in a seeded, disposable realm, or a documented feature or provider gate explains why not. |
| F1 | Every read through `keycloak_read` returns what raw HTTP returns: the same status and content class, and the same JSON value with exact numbers. |
| F2 | For each mutation case, running it through `keycloak_workflow` in one realm and through the reference in a twin realm gives the same status class and the same state on read-back. |
| F3 | A case keycloak-mcp accepts as reversible restores the earlier state when a forced failure makes keycloak-mcp compensate. |
| F4 | keycloak-mcp's own guarantees hold against the real server: realm pinning, gating, redaction, `IN_DOUBT` reporting, ID binding and receipts. A refusal sends no request, which a recording proxy confirms. |

Each reference operation ends with exactly one verdict in `equivalence/target/equivalence-ledger.json`:

- `EQUIVALENT`;
- `ROUTED_ONLY`, with a reason;
- `DIVERGENT_DOCUMENTED`, with the matching entries.

The ledger's provenance records:

- the git SHA and the image digest;
- the server version;
- the resolved admin-client snapshot, with its jar SHA-256 and source revision;
- the OpenAPI SHA-256 and the catalog version.

**Proves:** the checks above, for the image, feature profile, admin-client snapshot and definition that the run's ledger records. An operation is functionally equivalent only where the ledger says `EQUIVALENT`.

**Does not prove:**

- anything for a later or earlier Keycloak build;
- anything for the `latest` and `26.3.5` catalogs, which no live suite checks;
- equivalence of `ROUTED_ONLY` operations: they were routed, but no functional comparison covers them (for example, a mutation without a case);
- equivalence of `DIVERGENT_DOCUMENTED` operations, which differ in the documented way;
- anything about features that the container profile leaves off, or about effects outside Keycloak beyond what the suite observes;
- anything about production concerns such as clustering, federation against real directories, or load.

F1 compares reads with sensitive reads allowed. Redaction is checked separately, in F4.

Run it:

```sh
npm run test:equivalence                                       # mvn -f equivalence/pom.xml verify; needs Docker
mvn -f equivalence/pom.xml test                                # its own unit tests, no Docker
mvn -f equivalence/pom.xml verify -Dkeycloak.url=http://127.0.0.1:18080   # against a running server
```

`equivalence/README.md` lists every property, the mutation families and how to add a case.

## Updating the catalogs

1. Run `npm run catalog:update`. It downloads the `latest`, `26.3.5` and `nightly` definitions again and rewrites `data/`. Each catalog's `sourceSha256` is the SHA-256 of the bytes it downloaded.
2. If `nightly` changed, regenerate the admin-client supplement with `mvn -f equivalence/pom.xml -Psupplement`.
3. Review the diffs, then follow the failing tests:
   - `catalog-contract.test.js` names each definition whose size changed;
   - `classification.test.js` names each operation whose classification moved;
   - a supplement operation that no rule in `ADMIN_CLIENT_ROUTES` covers is treated as an irreversible mutation until a rule is added.
4. After review, record the new fixtures with `UPDATE_GOLDEN=1`. Commit them together with the data, and give the new SHA-256 values in the commit message.

## Opt-in live scripts

These scripts run against a real server and are never part of CI.

- **`npm run live:soak`** requires:
  - `KEYCLOAK_MCP_LIVE_SOAK=true`;
  - `KEYCLOAK_MCP_SOAK_CREDENTIALS`, naming a credentials file;
  - a realm whose name begins with `keycloak-mcp-soak-`.

  It runs real reads and reversible workflow cycles. Use a disposable realm, and check its cleanup yourself.
- **`npm run live:openclaw`** requires:
  - `KEYCLOAK_MCP_LIVE_OPENCLAW=true`;
  - an OpenClaw CLI;
  - a disposable loopback Keycloak;
  - `KEYCLOAK_MCP_OPENCLAW_BOOTSTRAP`, naming a `0600` JSON file with that server's bootstrap administrator.

  It installs the packed tarball into a throwaway OpenClaw home and calls the five tools through a local Gateway. It then runs one compensated write in a realm that it creates and deletes, and writes a receipt to `KEYCLOAK_MCP_OPENCLAW_OUT`. The receipt includes the SHA-256 of every source and data file.

## Archive

`docs/validation-history/2026-09/` keeps the evidence from live harness runs on 2026-09-26 to 2026-09-28: route ledgers, coverage runs and an OpenClaw integration. The record is historical: it predates the current source, CI does not verify it, and it is not published with the package.
