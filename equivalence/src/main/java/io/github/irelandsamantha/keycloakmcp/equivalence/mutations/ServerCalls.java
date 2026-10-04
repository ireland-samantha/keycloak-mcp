package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Raw JSON admin requests of the mutation checks, as the ground-truth oracle sends them. */
final class ServerCalls {

    private ServerCalls() {
    }

    static RawHttp.Response send(RawHttp http, String method, String pathAndQuery, JsonNode body) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "application/json");
        if (body != null) {
            headers.put("Content-Type", "application/json");
        }
        try {
            return http.send(method, pathAndQuery, headers, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException(method + " " + pathAndQuery + " failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted: " + method + " " + pathAndQuery, e);
        }
    }

    /** The JSON of a 200 answer; anything else throws. */
    static JsonNode get(RawHttp http, String pathAndQuery) {
        return expect2xx(send(http, "GET", pathAndQuery, null), "GET " + pathAndQuery).json();
    }

    static RawHttp.Response expect2xx(RawHttp.Response r, String request) {
        if (r.status() / 100 != 2) {
            throw new IllegalStateException(request + ": HTTP " + r.status() + " " + r.text());
        }
        return r;
    }
}
