package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The server's own record of admin writes in a realm that has admin events enabled: one event per successful
 * create, update, delete or action, stored in the same transaction as the change. A count that did not move proves
 * that nothing was written, whoever sent the request.
 */
public final class AdminEvents {

    private static final int MAX = 10_000;

    private AdminEvents() {
    }

    /** Every admin event of {@code realm}, newest first. */
    public static List<JsonNode> of(RawHttp http, String realm) throws IOException, InterruptedException {
        RawHttp.Response r = http.send("GET", "/admin/realms/" + RawHttp.segment(realm) + "/admin-events?first=0&max=" + MAX,
                Map.of("Accept", "application/json"), null);
        if (r.status() != 200) {
            throw new IllegalStateException("Cannot read the admin events of " + realm + ": HTTP " + r.status() + " " + r.text());
        }
        List<JsonNode> events = new ArrayList<>();
        r.json().forEach(events::add);
        return List.copyOf(events);
    }

    /** {@code operationType resourcePath} of each event, for failure messages and exact assertions. */
    public static List<String> summary(List<JsonNode> events) {
        return events.stream().map(e -> e.path("operationType").asText() + " " + e.path("resourcePath").asText()).toList();
    }
}
