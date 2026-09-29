package io.github.irelandsamantha.keycloakmcp.equivalence.ledger;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Everything that determined a run's verdicts. Keycloak nightly, the admin-client snapshot and the nightly OpenAPI
 * all float, so a ledger without these is not reproducible.
 *
 * @param gitSha             keycloak-mcp commit under test
 * @param gitDirty           uncommitted changes were present
 * @param image              Keycloak image ("external" for {@code keycloak.url})
 * @param imageDigest        repository digest of that image, when observable
 * @param serverUrl          where the server was reached
 * @param serverVersion      {@code systemInfo.version} from {@code GET /admin/serverinfo}
 * @param enabledFeatures    features the server reports enabled; gates, and so ROUTED_ONLY verdicts, depend on them
 * @param adminClientVersion resolved admin-client snapshot, e.g. {@code 999.0.0-20260928.023246-474}
 * @param jarSha256          digest of that jar
 * @param jarScmRevision     keycloak-client commit from the jar manifest
 * @param openapiSource      URL or pinned file of the HEAD OpenAPI definition
 * @param openapiSha256      digest of its bytes
 * @param catalogVersion     {@code KEYCLOAK_MCP_CATALOG_VERSION} under test
 * @param catalogSource      source keycloak-mcp reports for that catalog
 * @param catalogSha256      digest keycloak-mcp reports for that source
 */
public record Provenance(String gitSha, boolean gitDirty, String image, String imageDigest, String serverUrl,
                         String serverVersion, List<String> enabledFeatures, String adminClientVersion, String jarSha256,
                         String jarScmRevision,
                         String openapiSource, String openapiSha256, String catalogVersion, String catalogSource,
                         String catalogSha256) {

    /** Commit and dirtiness of a git checkout. */
    public record GitState(String sha, boolean dirty) {

        public static GitState of(Path checkout) {
            String sha = git(checkout, "rev-parse", "HEAD").strip();
            return new GitState(sha, !git(checkout, "status", "--porcelain").isBlank());
        }

        private static String git(Path checkout, String... args) {
            List<String> command = new ArrayList<>(List.of("git", "-C", checkout.toString()));
            command.addAll(List.of(args));
            try {
                Process p = new ProcessBuilder(command).redirectErrorStream(true).start();
                String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                if (!p.waitFor(30, TimeUnit.SECONDS) || p.exitValue() != 0) {
                    throw new IllegalStateException(String.join(" ", command) + " failed: " + out);
                }
                return out;
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            }
        }
    }
}
