package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Digests;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

/**
 * The Keycloak HEAD OpenAPI definition: the nightly document published on keycloak.org, or, when that cannot be
 * fetched, the copy keycloak-mcp pins in {@code data/openapi-nightly.json} (with a logged warning, because the pin
 * may lag HEAD).
 */
public final class HeadOpenApi {

    public static final URI NIGHTLY = URI.create("https://www.keycloak.org/docs-api/nightly/rest-api/openapi.json");
    public static final String PINNED = "data/openapi-nightly.json";

    private static final System.Logger LOG = System.getLogger(HeadOpenApi.class.getName());

    /** @param source URL or file the bytes came from */
    public record Document(String source, String sha256, JsonNode json) {
    }

    private HeadOpenApi() {
    }

    public static Document load(Path keycloakMcpRoot) {
        try {
            return fetch();
        } catch (IOException | RuntimeException e) {
            Path pinned = keycloakMcpRoot.resolve(PINNED).normalize();
            LOG.log(System.Logger.Level.WARNING, "Cannot fetch {0} ({1}); falling back to the pinned {2}, which may lag HEAD",
                    NIGHTLY, e.toString(), pinned);
            return read(pinned);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while fetching " + NIGHTLY, e);
        }
    }

    private static Document fetch() throws IOException, InterruptedException {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL).build();
        HttpResponse<byte[]> response = http.send(HttpRequest.newBuilder(NIGHTLY).timeout(Duration.ofSeconds(60)).GET().build(),
                HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode());
        }
        return document(NIGHTLY.toString(), response.body());
    }

    private static Document read(Path pinned) {
        if (!Files.isRegularFile(pinned)) {
            throw new IllegalStateException("No HEAD OpenAPI definition: " + NIGHTLY + " is unreachable and " + pinned
                    + " does not exist (run `npm run catalog:update` in keycloak-mcp)");
        }
        try {
            return document(pinned.toString(), Files.readAllBytes(pinned));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static Document document(String source, byte[] bytes) {
        JsonNode json = Json.read(bytes);
        if (!json.path("paths").isObject()) {
            throw new IllegalStateException(source + " is not an OpenAPI document (no paths object)");
        }
        return new Document(source, Digests.sha256(bytes), json);
    }
}
