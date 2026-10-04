package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RecordingProxyTest {

    private HttpServer backend;
    private final List<String> forwarded = new CopyOnWriteArrayList<>();
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

    @BeforeEach
    void startBackend() throws IOException {
        backend = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        backend.createContext("/", exchange -> {
            try (exchange) {
                forwarded.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getRawPath()
                        + (exchange.getRequestURI().getRawQuery() == null ? "" : "?" + exchange.getRequestURI().getRawQuery()));
                byte[] body = exchange.getRequestBody().readAllBytes();
                if (exchange.getRequestURI().getRawPath().endsWith("/groups")) {
                    exchange.getResponseHeaders().add("Location", backendUrl() + "/admin/realms/r/groups/new-id");
                    exchange.sendResponseHeaders(201, -1);
                } else {
                    exchange.sendResponseHeaders(200, body.length == 0 ? -1 : body.length);
                    exchange.getResponseBody().write(body);
                }
            }
        });
        backend.start();
    }

    @AfterEach
    void stopBackend() {
        backend.stop(0);
        http.close();
    }

    @Test
    void recordsAndForwardsTheRequestExactlyAsSent() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(backendUrl())) {
            send(proxy, "GET", "/admin/realms/r/groups/..%2Fother?q=%20x", null);
            assertEquals(List.of(new RecordingProxy.Request("GET", "/admin/realms/r/groups/..%2Fother", "q=%20x")), proxy.requests());
            assertEquals(List.of("GET /admin/realms/r/groups/..%2Fother?q=%20x"), forwarded);
        }
    }

    @Test
    void passesBodiesBothWays() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(backendUrl())) {
            HttpResponse<String> answer = send(proxy, "PUT", "/admin/realms/r/groups/g", "{\"name\":\"g\"}");
            assertEquals(200, answer.statusCode());
            assertEquals("{\"name\":\"g\"}", answer.body());
        }
    }

    @Test
    void pointsLocationsAtTheProxy() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(backendUrl())) {
            HttpResponse<String> created = send(proxy, "POST", "/admin/realms/r/groups", "{}");
            assertEquals(201, created.statusCode());
            assertEquals(proxy.baseUrl() + "/admin/realms/r/groups/new-id", created.headers().firstValue("Location").orElseThrow());
        }
    }

    @Test
    void tellsTokenGrantsFromAdminRequests() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(backendUrl())) {
            send(proxy, "POST", "/realms/master/protocol/openid-connect/token", "grant_type=client_credentials");
            send(proxy, "GET", "/admin/realms/r", null);
            assertEquals(List.of(new RecordingProxy.Request("GET", "/admin/realms/r", null)), proxy.adminRequests());
        }
    }

    private String backendUrl() {
        return "http://127.0.0.1:" + backend.getAddress().getPort();
    }

    private HttpResponse<String> send(RecordingProxy proxy, String method, String pathAndQuery, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(proxy.baseUrl() + pathAndQuery))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString());
    }
}
