package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Provenance;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientArtifact;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.HeadOpenApi;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;
import org.keycloak.OAuth2Constants;
import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.KeycloakBuilder;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeoutException;

/**
 * Everything the equivalence checks share for one run: the server, the service account both keycloak-mcp and the
 * raw-HTTP oracle use, the reference inputs (HEAD OpenAPI, admin-client surface), keycloak-mcp's catalog as seen
 * over MCP, and the ledger. Reference inputs are loaded once, on first use.
 */
public final class EquivalenceEnvironment implements AutoCloseable {

    private static final Path LEDGER = Path.of("target", "equivalence-ledger.json");

    /** Realm keycloak-mcp is pinned to while only its catalog is read; catalog tools never contact Keycloak. */
    private static final String CATALOG_ONLY_REALM = "equivalence-catalog";

    private final Settings settings;
    private final KeycloakServer server;
    private final Keycloak bootstrapAdmin;
    private final ServiceAccount serviceAccount;
    private final RawHttp http;
    private final Keycloak adminClient;
    private final EquivalenceLedger ledger = new EquivalenceLedger();
    private HeadOpenApi.Document headOpenApi;
    private WalkResult adminClientSurface;
    private McpCatalogSnapshot catalog;

    private EquivalenceEnvironment(Settings settings, KeycloakServer server, Keycloak bootstrapAdmin,
                                   ServiceAccount serviceAccount) {
        this.settings = settings;
        this.server = server;
        this.bootstrapAdmin = bootstrapAdmin;
        this.serviceAccount = serviceAccount;
        this.http = new RawHttp(server.baseUrl(), serviceAccount);
        this.adminClient = KeycloakBuilder.builder().serverUrl(server.baseUrl()).realm(ServiceAccount.AUTH_REALM)
                .grantType(OAuth2Constants.CLIENT_CREDENTIALS).clientId(serviceAccount.clientId())
                .clientSecret(serviceAccount.clientSecret()).build();
    }

    public static EquivalenceEnvironment start(Settings settings) {
        KeycloakServer server = KeycloakServer.start(settings);
        Keycloak admin = null;
        try {
            admin = KeycloakBuilder.builder().serverUrl(server.baseUrl()).realm(ServiceAccount.AUTH_REALM)
                    .clientId("admin-cli").username(settings.adminUser()).password(settings.adminPassword()).build();
            return new EquivalenceEnvironment(settings, server, admin, ServiceAccount.provision(admin));
        } catch (RuntimeException e) {
            if (admin != null) {
                admin.close();
            }
            server.close();
            throw e;
        }
    }

    /** Raw HTTP as the service account: the ground-truth oracle. */
    public RawHttp http() {
        return http;
    }

    /** The Java admin client authenticated as the shared service account: the typed oracle and fixture tool. */
    public Keycloak adminClient() {
        return adminClient;
    }

    public EquivalenceLedger ledger() {
        return ledger;
    }

    /** Starts keycloak-mcp pinned to {@code realm}, authenticated as the shared service account. */
    public KeycloakMcpProcess startKeycloakMcp(String realm, Map<String, String> env)
            throws IOException, InterruptedException, TimeoutException {
        return KeycloakMcpProcess.start(settings, server.baseUrl(), serviceAccount, realm, env);
    }

    public synchronized HeadOpenApi.Document headOpenApi() {
        if (headOpenApi == null) {
            headOpenApi = HeadOpenApi.load(settings.keycloakMcpRoot());
        }
        return headOpenApi;
    }

    public synchronized WalkResult adminClientSurface() {
        if (adminClientSurface == null) {
            adminClientSurface = AdminClientSurface.walk();
        }
        return adminClientSurface;
    }

    /** The catalog of {@link Settings#catalogVersion()} as keycloak-mcp's own tools report it. */
    public synchronized McpCatalogSnapshot catalog() throws IOException, InterruptedException, TimeoutException {
        if (catalog == null) {
            try (KeycloakMcpProcess mcp = startKeycloakMcp(CATALOG_ONLY_REALM, Map.of())) {
                catalog = McpCatalogSnapshot.read(mcp.client(), settings.catalogVersion());
            }
        }
        return catalog;
    }

    public Provenance provenance() throws IOException, InterruptedException, TimeoutException {
        Provenance.GitState git = Provenance.GitState.of(settings.keycloakMcpRoot());
        AdminClientArtifact jar = AdminClientArtifact.inspect(AdminClientSurface.jar());
        McpCatalogSnapshot cat = catalog();
        String serverVersion = http.send("GET", "/admin/serverinfo", Map.of("Accept", "application/json"), null)
                .json().path("systemInfo").path("version").asText(null);
        return new Provenance(git.sha(), git.dirty(), server.image(), server.imageDigest(), server.baseUrl(),
                serverVersion, jar.resolvedVersion(), jar.sha256(), jar.scmRevision(), headOpenApi().source(),
                headOpenApi().sha256(), cat.version(), cat.source(), cat.sourceSha256());
    }

    public void writeLedger() throws IOException, InterruptedException, TimeoutException {
        ledger.write(LEDGER, provenance());
    }

    @Override
    public void close() {
        try {
            adminClient.close();
            serviceAccount.delete(bootstrapAdmin);
        } finally {
            bootstrapAdmin.close();
            server.close();
        }
    }
}
