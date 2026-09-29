package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;

/**
 * One {@code node <keycloak-mcp>/src/index.js} stdio server, configured the way an operator would: connection and
 * secret in a private (0600) config file, safety switches in the environment, journal and {@code HOME} in a private
 * (0700) temporary directory so nothing leaks into the real home directory (TA-03).
 */
public final class KeycloakMcpProcess implements AutoCloseable {

    /** The redaction switch: {@code true} shows secrets as the server returns them. */
    public static final String ALLOW_SENSITIVE_READS = "KEYCLOAK_MCP_ALLOW_SENSITIVE_READS";

    /**
     * Lifts keycloak-mcp's refusal of every operation without {@code {realm}}, which acts beyond the pinned realm
     * (SEC-5): {@code GET /admin/realms} returns every realm the token can see.
     */
    public static final String ALLOW_REALM_ADMIN = "KEYCLOAK_MCP_ALLOW_REALM_ADMIN";

    /** The path variable keycloak-mcp pins; an operation whose catalog path lacks it needs {@link #ALLOW_REALM_ADMIN}. */
    private static final String REALM_VARIABLE = "{realm}";

    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(60);

    private final Path workDir;
    private final Path journalDir;
    private final McpStdioClient client;

    private KeycloakMcpProcess(Path workDir, Path journalDir, McpStdioClient client) {
        this.workDir = workDir;
        this.journalDir = journalDir;
        this.client = client;
    }

    /**
     * Starts keycloak-mcp against {@code realm} and completes the MCP handshake.
     *
     * @param env additional {@code KEYCLOAK_MCP_*} switches (e.g. {@code KEYCLOAK_MCP_ALLOW_WRITE=true}); a
     *            {@code null} value leaves that switch unset, so keycloak-mcp runs with the default it ships. Sensitive
     *            reads are allowed unless {@code env} names {@value #ALLOW_SENSITIVE_READS}, because equivalence
     *            compares unredacted values
     */
    public static KeycloakMcpProcess start(Settings settings, String baseUrl, ServiceAccount account, String realm,
                                           Map<String, String> env) throws IOException, InterruptedException, TimeoutException {
        Path workDir = Files.createTempDirectory("keycloak-mcp-", PosixFilePermissions.asFileAttribute(
                PosixFilePermissions.fromString("rwx------")));
        try {
            Path config = writeConfig(workDir, baseUrl, account, realm);
            Path journal = Files.createDirectory(workDir.resolve("journal"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Map<String, String> processEnv = environment(workDir, config, journal, settings.catalogVersion(), env);
            List<String> command = List.of(settings.node(), settings.keycloakMcpRoot().resolve("src/index.js").toString());
            McpStdioClient client = McpStdioClient.start(command, processEnv, REQUEST_TIMEOUT);
            try {
                client.initialize();
            } catch (IOException | TimeoutException | RuntimeException e) {
                client.close();
                throw e;
            }
            return new KeycloakMcpProcess(workDir, journal, client);
        } catch (IOException | TimeoutException | RuntimeException e) {
            deleteRecursively(workDir);
            throw e;
        }
    }

    /**
     * The process environment: private home, config and journal, the catalog version, then {@code switches} as
     * {@link #start} documents them.
     */
    static Map<String, String> environment(Path home, Path config, Path journal, String catalogVersion,
                                           Map<String, String> switches) {
        Map<String, String> out = new LinkedHashMap<>();
        out.put("HOME", home.toString());
        out.put("KEYCLOAK_MCP_CONFIG", config.toString());
        out.put("KEYCLOAK_MCP_CATALOG_VERSION", catalogVersion);
        out.put(ALLOW_SENSITIVE_READS, "true");
        out.put("KEYCLOAK_MCP_JOURNAL_DIR", journal.toString());
        out.putAll(switches);
        out.values().removeIf(Objects::isNull);
        return out;
    }

    /**
     * Whether keycloak-mcp runs an operation of this catalog path only with {@link #ALLOW_REALM_ADMIN}: the path has no
     * {@code {realm}} (keycloak-mcp {@code src/policy/access.js}).
     */
    public static boolean needsRealmAdministration(String catalogPath) {
        return !catalogPath.contains(REALM_VARIABLE);
    }

    public McpStdioClient client() {
        return client;
    }

    /** {@code KEYCLOAK_MCP_JOURNAL_DIR}: where workflow receipts land; removed with the process. */
    public Path journalDir() {
        return journalDir;
    }

    /** Ends the process; an interrupt while waiting for it is kept on the thread, not thrown. */
    @Override
    public void close() {
        try {
            client.close();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            deleteRecursively(workDir);
        }
    }

    private static Path writeConfig(Path workDir, String baseUrl, ServiceAccount account, String realm) throws IOException {
        Map<String, String> config = new LinkedHashMap<>();
        config.put("KEYCLOAK_BASE_URL", baseUrl);
        config.put("KEYCLOAK_REALM", realm);
        config.put("KEYCLOAK_AUTH_REALM", ServiceAccount.AUTH_REALM);
        config.put("KEYCLOAK_CLIENT_ID", account.clientId());
        config.put("KEYCLOAK_CLIENT_SECRET", account.clientSecret());
        Path file = Files.createFile(workDir.resolve("config.json"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(file, Json.MAPPER.writeValueAsString(config));
        return file;
    }

    private static void deleteRecursively(Path dir) {
        try (Stream<Path> paths = Files.walk(dir)) {
            for (Path p : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot remove " + dir, e);
        }
    }
}
