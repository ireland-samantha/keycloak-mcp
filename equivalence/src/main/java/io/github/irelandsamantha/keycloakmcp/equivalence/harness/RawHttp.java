package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;

/**
 * The ground-truth oracle's transport: plain HTTP against the live server with the same service-account token
 * keycloak-mcp uses, no client library in between (the admin client leaves {@code ;} unencoded in path segments,
 * so it cannot be trusted for encoding).
 */
public final class RawHttp {

    /** A response as received: status, headers and the undecoded body. */
    public record Response(int status, Map<String, List<String>> headers, byte[] body) {
        public String text() {
            return new String(body, StandardCharsets.UTF_8);
        }

        public JsonNode json() {
            return Json.read(body);
        }
    }

    private static final Duration TIMEOUT = Duration.ofSeconds(60);
    private static final Duration REFRESH_BEFORE_EXPIRY = Duration.ofSeconds(30);

    private final String baseUrl;
    private final ServiceAccount account;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private String token;
    private Instant tokenExpiry = Instant.EPOCH;

    public RawHttp(String baseUrl, ServiceAccount account) {
        this.baseUrl = baseUrl;
        this.account = account;
    }

    /** Percent-encodes one path segment ({@code /} and {@code ;} included, spaces as {@code %20}). */
    public static String segment(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    /**
     * Sends an authenticated request.
     *
     * @param pathAndQuery already-encoded path (and query) below the server root, e.g. {@code /admin/realms/x/users}
     * @param body         {@code null} for no body
     */
    public Response send(String method, String pathAndQuery, Map<String, String> headers, byte[] body)
            throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + pathAndQuery))
                .timeout(TIMEOUT)
                .header("Authorization", "Bearer " + accessToken())
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        headers.forEach(request::header);
        return execute(request.build());
    }

    /** A client-credentials token for the service account, reused until shortly before it expires. */
    public synchronized String accessToken() throws IOException, InterruptedException {
        if (token != null && Instant.now().isBefore(tokenExpiry.minus(REFRESH_BEFORE_EXPIRY))) {
            return token;
        }
        String basic = Base64.getEncoder().encodeToString(
                (account.clientId() + ":" + account.clientSecret()).getBytes(StandardCharsets.UTF_8));
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/realms/" + ServiceAccount.AUTH_REALM
                        + "/protocol/openid-connect/token"))
                .timeout(TIMEOUT)
                .header("Authorization", "Basic " + basic)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString("grant_type=client_credentials"))
                .build();
        Response response = execute(request);
        if (response.status() != 200) {
            throw new IOException("Service-account token request failed: HTTP " + response.status() + " " + response.text());
        }
        JsonNode grant = response.json();
        token = grant.path("access_token").asText();
        tokenExpiry = Instant.now().plusSeconds(grant.path("expires_in").asLong());
        return token;
    }

    private Response execute(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        return new Response(response.statusCode(), response.headers().map(), response.body());
    }
}
