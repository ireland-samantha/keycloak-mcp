package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A loopback HTTP proxy in front of the Keycloak server that records every request passing through it exactly as
 * the client sent it: method, raw (still encoded) path and query. Pointing keycloak-mcp at it shows what keycloak-mcp
 * put on the wire, so a check can prove that a refusal sent nothing and that every request stayed inside the pinned
 * realm, which the server's own logs cannot show for reads.
 *
 * <p>{@code Location} headers are rewritten to the proxy's origin, because keycloak-mcp only binds a created
 * resource whose {@code Location} lies on its configured origin.
 */
public final class RecordingProxy implements AutoCloseable {

    /** One request as received. */
    public record Request(String method, String rawPath, String rawQuery) {
        public boolean tokenRequest() {
            return rawPath.endsWith("/protocol/openid-connect/token");
        }

        @Override
        public String toString() {
            return method + " " + rawPath + (rawQuery == null ? "" : "?" + rawQuery);
        }
    }

    /** Headers the JDK client sets itself, or that describe one hop only. */
    private static final Set<String> HOP_HEADERS = Set.of("connection", "content-length", "expect", "host", "upgrade",
            "transfer-encoding", "keep-alive");

    private final String target;
    private final HttpServer server;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(10)).build();
    private final List<Request> requests = new CopyOnWriteArrayList<>();

    private RecordingProxy(String target, HttpServer server) {
        this.target = target.replaceAll("/+$", "");
        this.server = server;
        server.createContext("/", this::forward);
        server.setExecutor(executor);
        server.start();
    }

    /** Starts a proxy on an ephemeral loopback port that forwards to {@code target}, e.g. {@code http://host:8080}. */
    public static RecordingProxy start(String target) throws IOException {
        return new RecordingProxy(target, HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0));
    }

    /** The URL to configure a client with instead of the server's. */
    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** Every request received so far, in arrival order. */
    public List<Request> requests() {
        return List.copyOf(requests);
    }

    /** Requests other than service-account token grants. */
    public List<Request> adminRequests() {
        return requests.stream().filter(r -> !r.tokenRequest()).toList();
    }

    @Override
    public void close() {
        server.stop(0);
        executor.close();
        client.close();
    }

    private void forward(HttpExchange exchange) throws IOException {
        try (exchange) {
            URI uri = exchange.getRequestURI();
            String query = uri.getRawQuery();
            requests.add(new Request(exchange.getRequestMethod(), uri.getRawPath(), query));
            byte[] body = exchange.getRequestBody().readAllBytes();
            URI forwarded = URI.create(target + uri.getRawPath() + (query == null ? "" : "?" + query));
            HttpRequest.Builder request = HttpRequest.newBuilder(forwarded)
                    .timeout(Duration.ofSeconds(60))
                    .method(exchange.getRequestMethod(), body.length == 0 ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofByteArray(body));
            exchange.getRequestHeaders().forEach((name, values) -> {
                if (!HOP_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                    values.forEach(v -> request.header(name, v));
                }
            });
            HttpResponse<byte[]> response = send(request.build());
            response.headers().map().forEach((name, values) -> {
                String lower = name.toLowerCase(Locale.ROOT);
                if (!HOP_HEADERS.contains(lower) && !name.startsWith(":")) {
                    values.forEach(v -> exchange.getResponseHeaders().add(name, lower.equals("location") ? toProxy(v) : v));
                }
            });
            byte[] answer = response.body();
            exchange.sendResponseHeaders(response.statusCode(), answer.length == 0 ? -1 : answer.length);
            exchange.getResponseBody().write(answer);
        }
    }

    private HttpResponse<byte[]> send(HttpRequest request) throws IOException {
        try {
            return client.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while forwarding " + request.uri(), e);
        }
    }

    private String toProxy(String location) {
        return location.startsWith(target) ? baseUrl() + location.substring(target.length()) : location;
    }
}
