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
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;

/**
 * One {@code node <keycloak-mcp>/src/index.js} stdio server, configured the way an operator would: connection and
 * secret in a private (0600) config file, safety switches in the environment, journal and {@code HOME} in a private
 * (0700) temporary directory so nothing leaks into the real home directory (TA-03).
 */
public final class KeycloakMcpProcess implements AutoCloseable {

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
     * @param env additional {@code KEYCLOAK_MCP_*} switches (e.g. {@code KEYCLOAK_MCP_ALLOW_WRITE=true}); sensitive
     *            reads are allowed by default because equivalence compares unredacted values
     */
    public static KeycloakMcpProcess start(Settings settings, String baseUrl, ServiceAccount account, String realm,
                                           Map<String, String> env) throws IOException, InterruptedException, TimeoutException {
        Path workDir = Files.createTempDirectory("keycloak-mcp-", PosixFilePermissions.asFileAttribute(
                PosixFilePermissions.fromString("rwx------")));
        try {
            Path config = writeConfig(workDir, baseUrl, account, realm);
            Path journal = Files.createDirectory(workDir.resolve("journal"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Map<String, String> processEnv = new LinkedHashMap<>();
            processEnv.put("HOME", workDir.toString());
            processEnv.put("KEYCLOAK_MCP_CONFIG", config.toString());
            processEnv.put("KEYCLOAK_MCP_CATALOG_VERSION", settings.catalogVersion());
            processEnv.put("KEYCLOAK_MCP_ALLOW_SENSITIVE_READS", "true");
            processEnv.put("KEYCLOAK_MCP_JOURNAL_DIR", journal.toString());
            processEnv.putAll(env);
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
