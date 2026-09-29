package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.RealmSeeder;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Provenance;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientArtifact;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.HeadOpenApi;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.ReferenceSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;
import org.keycloak.OAuth2Constants;
import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.KeycloakBuilder;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;

/**
 * Everything the equivalence checks share for one run: the server, the service account both keycloak-mcp and the
 * raw-HTTP oracle use, the reference inputs (HEAD OpenAPI, admin-client surface), keycloak-mcp's catalog as seen
 * over MCP, and the ledger. Reference inputs are loaded once, on first use; the ledger holds a row for every
 * reference operation from then on, whichever checks run.
 */
public final class EquivalenceEnvironment implements AutoCloseable {

    private static final Path LEDGER = Path.of("target", "equivalence-ledger.json");

    /** Realm keycloak-mcp is pinned to while only its catalog is read; catalog tools never contact Keycloak. */
    private static final String CATALOG_ONLY_REALM = "equivalence-catalog";

    private final Settings settings;
    private final SmtpSink mail;
    private final KeycloakServer server;
    private final Keycloak bootstrapAdmin;
    private final ServiceAccount serviceAccount;
    private final RawHttp http;
    private final Keycloak adminClient;
    private final EquivalenceLedger ledger = new EquivalenceLedger();
    private HeadOpenApi.Document headOpenApi;
    private WalkResult adminClientSurface;
    private ReferenceSurface reference;
    private McpCatalogSnapshot catalog;

    private EquivalenceEnvironment(Settings settings, SmtpSink mail, KeycloakServer server, Keycloak bootstrapAdmin,
                                   ServiceAccount serviceAccount) {
        this.settings = settings;
        this.mail = mail;
        this.server = server;
        this.bootstrapAdmin = bootstrapAdmin;
        this.serviceAccount = serviceAccount;
        this.http = new RawHttp(server.baseUrl(), serviceAccount);
        this.adminClient = KeycloakBuilder.builder().serverUrl(server.baseUrl()).realm(ServiceAccount.AUTH_REALM)
                .grantType(OAuth2Constants.CLIENT_CREDENTIALS).clientId(serviceAccount.clientId())
                .clientSecret(serviceAccount.clientSecret()).build();
    }

    public static EquivalenceEnvironment start(Settings settings) {
        SmtpSink mail;
        try {
            mail = SmtpSink.start();
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot start the SMTP sink", e);
        }
        KeycloakServer server = null;
        Keycloak admin = null;
        try {
            server = KeycloakServer.start(settings, mail.port());
            admin = KeycloakBuilder.builder().serverUrl(server.baseUrl()).realm(ServiceAccount.AUTH_REALM)
                    .clientId("admin-cli").username(settings.adminUser()).password(settings.adminPassword()).build();
            return new EquivalenceEnvironment(settings, mail, server, admin, ServiceAccount.provision(admin));
        } catch (RuntimeException e) {
            if (admin != null) {
                admin.close();
            }
            if (server != null) {
                server.close();
            }
            closeQuietly(mail);
            throw e;
        }
    }

    public String serverUrl() {
        return server.baseUrl();
    }

    /** The service account keycloak-mcp, the raw oracle and the admin client all authenticate as. */
    public ServiceAccount serviceAccount() {
        return serviceAccount;
    }

    /** Raw HTTP as the service account: the ground-truth oracle. */
    public RawHttp http() {
        return http;
    }

    /** The Java admin client authenticated as the shared service account: the typed oracle and fixture tool. */
    public Keycloak adminClient() {
        return adminClient;
    }

    /** The ledger, with a row for every reference operation. */
    /** Seeds disposable realms on this server; their mail goes to this run's SMTP sink. */
    public RealmSeeder seeder() {
        return new RealmSeeder(adminClient, new RealmSeeder.Context(server.baseUrl(), server.callbackHost(), mail.port()));
    }

    public EquivalenceLedger ledger() {
        reference();
        return ledger;
    }

    /**
     * Starts keycloak-mcp pinned to {@code realm}, authenticated as the shared service account, with {@code env} as
     * {@link KeycloakMcpProcess#start} takes it.
     */
    public KeycloakMcpProcess startKeycloakMcp(String realm, Map<String, String> env)
            throws IOException, InterruptedException, TimeoutException {
        return startKeycloakMcp(realm, env, server.baseUrl());
    }

    /** As {@link #startKeycloakMcp(String, Map)}, but reaching the server through {@code baseUrl}, e.g. a {@link RecordingProxy}. */
    public KeycloakMcpProcess startKeycloakMcp(String realm, Map<String, String> env, String baseUrl)
            throws IOException, InterruptedException, TimeoutException {
        return KeycloakMcpProcess.start(settings, baseUrl, serviceAccount, realm, env);
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

    /** HEAD OpenAPI ∪ admin client, each operation registered in the ledger with its origins. */
    public synchronized ReferenceSurface reference() {
        if (reference == null) {
            reference = ReferenceSurface.of(headOpenApi().json(), adminClientSurface());
            reference.openApi().values().forEach(op -> ledger.reference(op.method(), op.path(), ReferenceSurface.OPENAPI));
            reference.adminClient().values().forEach(op -> ledger.reference(op.method(), op.path(), ReferenceSurface.ADMIN_CLIENT));
        }
        return reference;
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
        JsonNode info = http.send("GET", "/admin/serverinfo", Map.of("Accept", "application/json"), null).json();
        List<String> enabledFeatures = new ArrayList<>();
        info.path("features").forEach(f -> {
            if (f.path("enabled").asBoolean()) {
                enabledFeatures.add(f.path("name").asText());
            }
        });
        Collections.sort(enabledFeatures);
        return new Provenance(git.sha(), git.dirty(), server.image(), server.imageDigest(), server.baseUrl(),
                info.path("systemInfo").path("version").asText(null), List.copyOf(enabledFeatures),
                jar.resolvedVersion(), jar.sha256(), jar.scmRevision(), headOpenApi().source(),
                headOpenApi().sha256(), cat.version(), cat.source(), cat.sourceSha256());
    }

    public void writeLedger() throws IOException, InterruptedException, TimeoutException {
        ledger().write(LEDGER, provenance());
    }

    @Override
    public void close() {
        try {
            adminClient.close();
            serviceAccount.delete(bootstrapAdmin);
        } finally {
            bootstrapAdmin.close();
            server.close();
            closeQuietly(mail);
        }
    }

    private static void closeQuietly(SmtpSink mail) {
        try {
            mail.close();
        } catch (IOException ignored) {
            // only a listening socket; the JVM releases it on exit anyway
        }
    }
}
