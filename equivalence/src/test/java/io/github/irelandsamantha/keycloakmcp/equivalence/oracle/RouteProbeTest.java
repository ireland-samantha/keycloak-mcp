package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RouteProbeTest {

    @Test
    void onlyTheGenericMissAnd405MeanUnrouted() {
        assertEquals(RouteProbe.Verdict.GENERIC_MISS, RouteProbe.verdict(404, RouteProbe.GENERIC_MISS_BODY));
        assertEquals(RouteProbe.Verdict.GENERIC_MISS, RouteProbe.verdict(405, "{\"error\":\"HTTP 405 Method Not Allowed\"}"));
        assertEquals(RouteProbe.Verdict.ROUTED, RouteProbe.verdict(404, "{\"error\":\"User not found\"}"));
        assertEquals(RouteProbe.Verdict.ROUTED, RouteProbe.verdict(400, "{\"error\":\"unknown_error\",\"error_description\":\"Cannot parse the JSON\"}"));
        assertEquals(RouteProbe.Verdict.ROUTED, RouteProbe.verdict(501, "{\"error\":\"Feature not enabled\"}"));
        assertEquals(RouteProbe.Verdict.UNAUTHORIZED, RouteProbe.verdict(403, "{\"error\":\"HTTP 403 Forbidden\"}"));
    }
}
