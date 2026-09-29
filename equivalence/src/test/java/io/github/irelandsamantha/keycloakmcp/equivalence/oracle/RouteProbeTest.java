package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class RouteProbeTest {

    private static final String WORKFLOW_NOT_FOUND = "{\"error\":\"Workflow with id missing not found\"}";

    private final List<String> sent = new ArrayList<>();

    @Test
    void onlyTheGenericMissAnd405MeanUnrouted() {
        assertEquals(RouteProbe.Verdict.GENERIC_MISS, RouteProbe.verdict(404, RouteProbe.GENERIC_MISS_BODY));
        assertEquals(RouteProbe.Verdict.GENERIC_MISS, RouteProbe.verdict(405, "{\"error\":\"HTTP 405 Method Not Allowed\"}"));
        assertEquals(RouteProbe.Verdict.ROUTED, RouteProbe.verdict(404, "{\"error\":\"User not found\"}"));
        assertEquals(RouteProbe.Verdict.ROUTED, RouteProbe.verdict(400, "{\"error\":\"unknown_error\",\"error_description\":\"Cannot parse the JSON\"}"));
        assertEquals(RouteProbe.Verdict.ROUTED, RouteProbe.verdict(501, "{\"error\":\"Feature not enabled\"}"));
        assertEquals(RouteProbe.Verdict.UNAUTHORIZED, RouteProbe.verdict(403, "{\"error\":\"HTTP 403 Forbidden\"}"));
    }

    @Test
    void aLocatorRejectingAnUnseededIdProvesNothingAboutTheOperationsBelowIt() throws Exception {
        List<RouteProbe.Result> results = probe(template -> List.of("r", "missing"),
                target("GET", "/admin/realms/{realm}/workflows/{id}"),
                target("GET", "/admin/realms/{realm}/workflows/{id}/no-such-operation"));

        for (RouteProbe.Result r : results) {
            assertEquals(RouteProbe.Verdict.INCONCLUSIVE, r.verdict(), r.template());
            assertEquals("404 " + WORKFLOW_NOT_FOUND, r.control());
        }
        assertEquals("GET /admin/realms/r/workflows/missing/" + RouteProbe.CONTROL_SEGMENT, sent.get(1));
    }

    @Test
    void aSpecificErrorFromTheMethodItselfIsRouted() throws Exception {
        RouteProbe.Result r = probe(template -> List.of("r", "missing"),
                target("DELETE", "/admin/realms/{realm}/sessions/{session}")).getFirst();

        assertEquals(RouteProbe.Verdict.ROUTED, r.verdict());
        assertEquals("404 " + RouteProbe.GENERIC_MISS_BODY, r.control());
    }

    @Test
    void aSeededIdReachesTheOperationAndExposesAMissingOne() throws Exception {
        List<RouteProbe.Result> results = probe(template -> List.of("r", "wf-1"),
                target("GET", "/admin/realms/{realm}/workflows/{id}"),
                target("GET", "/admin/realms/{realm}/workflows/{id}/no-such-operation"));

        assertEquals(RouteProbe.Verdict.ROUTED, results.get(0).verdict());
        assertNull(results.get(0).control(), "a 2xx needs no control request");
        assertEquals(RouteProbe.Verdict.GENERIC_MISS, results.get(1).verdict());
        assertEquals(2, sent.size());
    }

    private List<RouteProbe.Result> probe(Function<String, List<String>> values, RouteProbe.Target... targets)
            throws Exception {
        return new RouteProbe(this::keycloak, values, Map.of()).probe(List.of(targets));
    }

    /**
     * Keycloak's shape for two resources: {@code workflows/{id}} is a validating sub-resource locator whose only
     * resource method here is {@code GET}; {@code DELETE sessions/{session}} is a resource method that answers an
     * unknown session with its own 404.
     */
    private RawHttp.Response keycloak(String method, String path, Map<String, String> headers, byte[] body) {
        sent.add(method + " " + path);
        if (path.startsWith("/admin/realms/r/workflows/missing")) {
            return response(404, WORKFLOW_NOT_FOUND);
        }
        if (method.equals("GET") && path.equals("/admin/realms/r/workflows/wf-1")) {
            return response(200, "{\"id\":\"wf-1\"}");
        }
        if (method.equals("DELETE") && path.equals("/admin/realms/r/sessions/missing")) {
            return response(404, "{\"error\":\"Sesssion not found\"}");
        }
        return response(404, RouteProbe.GENERIC_MISS_BODY);
    }

    private static RawHttp.Response response(int status, String body) {
        return new RawHttp.Response(status, Map.of(), body.getBytes(StandardCharsets.UTF_8));
    }

    private static RouteProbe.Target target(String method, String template) {
        return new RouteProbe.Target(method + " " + template, method, template, Set.of());
    }
}
