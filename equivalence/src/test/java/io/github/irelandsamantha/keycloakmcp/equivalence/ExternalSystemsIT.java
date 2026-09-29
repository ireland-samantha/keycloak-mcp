package io.github.irelandsamantha.keycloakmcp.equivalence;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.DisposableRealm;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.ExternalSystems;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.images.builder.Transferable;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The server under test reaches what {@link ExternalSystems} gives it, in either mode: a container started for it and
 * a port of this JVM. The probe is the identity-provider {@code import-config}, which fetches {@code fromUrl} from the
 * server and only parses it (IdentityProvidersResource.java:181-200), so it creates nothing; the answer names the
 * token endpoint of the discovery document it fetched. Families rely on this to exercise mutations that need such a
 * system instead of documenting them as mutation gates.
 */
@ExtendWith(EquivalenceExtension.class)
class ExternalSystemsIT {

    private static final int PORT = 8080;
    private static final String TOKEN_URL = "https://discovery.example/token";
    private static final String DISCOVERY = """
            {"issuer": "https://discovery.example", "authorization_endpoint": "https://discovery.example/auth",
             "token_endpoint": "%s", "jwks_uri": "https://discovery.example/certs"}""".formatted(TOKEN_URL);
    /** Reads one request's headers, then answers with the discovery document (busybox has no HTTP server). */
    private static final String RESPOND = """
            while IFS= read -r line; do [ -z "$(printf '%%s' "$line" | tr -d '\\r')" ] && break; done
            body='%s'
            printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: %%s\\r\\nConnection: close\\r\\n\\r\\n%%s' "${#body}" "$body"
            """.formatted(DISCOVERY.replace("\n", ""));

    private static EquivalenceEnvironment env;
    private static DisposableRealm realm;

    @BeforeAll
    static void start(EquivalenceEnvironment environment) {
        env = environment;
        realm = DisposableRealm.create(env.adminClient(), "equivalence-systems-" + System.currentTimeMillis(), r -> {
        });
    }

    @AfterAll
    static void stop() {
        if (realm != null) {
            realm.close();
        }
    }

    @Test
    void theServerReachesAContainerStartedForIt() throws Exception {
        ExternalSystems.Sidecar sidecar = env.systems().container("discovery", PORT,
                () -> new GenericContainer<>("alpine:3.20")
                        .withCopyToContainer(Transferable.of(RESPOND), "/respond.sh")
                        .withCommand("nc", "-lk", "-p", String.valueOf(PORT), "-e", "sh", "/respond.sh"));
        assertEquals(TOKEN_URL, imported(sidecar.fromServer()).path("tokenUrl").asText());
    }

    @Test
    void theServerReachesAPortOfThisJvm() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/", exchange -> {
            byte[] body = DISCOVERY.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        try {
            assertEquals(TOKEN_URL, imported(env.systems().jvmPort(server.getAddress().getPort())).path("tokenUrl").asText());
        } finally {
            server.stop(0);
        }
    }

    /** The configuration the server parsed from the discovery document it fetched at {@code address}. */
    private static JsonNode imported(ExternalSystems.Address address) throws Exception {
        String body = """
                {"providerId": "oidc", "fromUrl": "http://%s/.well-known/openid-configuration"}"""
                .formatted(address.hostAndPort());
        String path = "/admin/realms/" + RawHttp.segment(realm.name()) + "/identity-provider/import-config";
        RawHttp.Response r = env.http().send("POST", path, Map.of("Content-Type", "application/json", "Accept", "application/json"),
                body.getBytes(StandardCharsets.UTF_8));
        assertEquals(200, r.status(), () -> "import-config from " + address.hostAndPort() + ": " + r.text());
        return r.json();
    }
}
