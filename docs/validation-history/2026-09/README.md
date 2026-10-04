# Validation history, September 2026

This directory is an archive. `VALIDATION.md` and the 56 files under `validation/` are the evidence record from live harness runs on 2026-09-26 to 2026-09-28. They used to sit at the repository root and were published in the npm package. They were moved here byte-for-byte with `git mv`, so `git log --follow` still shows how they were written. CI does not read or verify them, and they are no longer published.

## What the record covers

| Evidence | Keycloak | keycloak-mcp source it names |
| --- | --- | --- |
| 26.3.5 read and mutation coverage, feature-gated and isolated runs (`*-26.3.5*.json[l]`) | 26.3.5: deployed custom image and isolated containers of it | 26.3.5 catalog `sourceSha256` `c13a159f…` |
| Latest-catalog route ledger and probes (`latest-*26.7.4*.json`) | `quay.io/keycloak/keycloak:26.7.4@sha256:82a77884…` | `latest` catalog `ba68e1c3…`; `src/keycloak.js` `f15f36b5…` (commit b8422b4); `src/workflow.js` `ed3b0695…` (earlier than the first commit) |
| One production compensation cycle (`current-workflow-production-cycle.json`) | the deployed 26.3.5 server | `src/keycloak.js` `f15f36b5…`, `src/workflow.js` `790f4aec…` (commit b8422b4) |
| OpenClaw Gateway integration (`openclaw-2026.9.6-*.json`) | 26.7.4 | OpenClaw 2026.9.6; `src/keycloak.js` `fed2ad51…`, `src/workflow.js` `790f4aec…` (commits 0f16b7f to 0cc6d1b) |

The record is historical. Most of it predates the source it now ships with, and it says nothing about code after commit 0cc6d1b. Links in `VALIDATION.md` to `scripts/…` refer to the repository root at that commit.

## What replaces it

Reproducible suites, described with what each proves and does not prove in [TESTING.md](../../../TESTING.md):

- `npm run test:unit`: behaviour tests, plus golden masters of catalog, request building, preflight and workflow receipts. CI runs it.
- `npm run test:mock`: the real stdio server driven over MCP against a mock Keycloak whose default bodies were recorded from a Keycloak HEAD server. CI runs it.
- `npm run test:equivalence`: the Testcontainers equivalence suite in `equivalence/`. It checks keycloak-mcp against a live Keycloak HEAD server and the Java admin client, and writes a per-run ledger to `equivalence/target/equivalence-ledger.json`. It needs Docker and is run outside the CI workflow.
