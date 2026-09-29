package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ReadJudgeTest {

    private static final String KEY = "GET /admin/realms/{}/client-types";
    private static final String TEMPLATE = "/admin/realms/{realm}/client-types";
    private static final Observation GATED = Observation.ofHttp(501, "application/json",
            "{\"error\":\"Feature not enabled\"}".getBytes(StandardCharsets.UTF_8));

    private final ReadJudge judge = new ReadJudge(DocumentedDivergences.parse(Json.read("""
            {"divergences": [{"key": "GET /admin/realms/{realm}/client-types", "kind": "read-gate", "sources": "server",
              "observed": {"server": ["501 {\\"error\\":\\"Feature not enabled\\"}"]},
              "reason": "experimental feature client-types is off", "evidence": "X.java:1", "since": "2026-09-29"}]}
            """.getBytes())), KnownLag.parse(Json.read("""
            {"lag": [{"key": "GET /admin/realms/{realm}/client-types", "path": "$.x", "kind": "MISSING_RIGHT",
              "reason": "adapter drops x", "evidence": "X.java:2", "since": "2026-09-29"}]}
            """.getBytes())));

    @Test
    void aReadMissingFromTheCatalogIsNamedSo() throws Exception {
        Check c = judge.mcp(KEY, TEMPLATE, false, compare(json("{}"), Observation.failure(0, "not in catalog")));
        assertEquals(ReadJudge.CATALOG_MISSING, c.outcome());
        assertFalse(c.accepted());
        assertEquals(ReadJudge.MCP_REFUSED, judge.mcp(KEY, TEMPLATE, true, compare(json("{}"), Observation.failure(0, "no"))).outcome());
    }

    @Test
    void aDocumentedGateIsRoutedOnlyWithItsReason() throws Exception {
        Check c = judge.mcp(KEY, TEMPLATE, true, compare(GATED, Observation.failure(501, "HTTP 501")));
        assertEquals("ROUTED_ONLY", c.outcome());
        assertTrue(c.accepted());
        assertTrue(c.detail().contains("client-types is off"), c.detail());
    }

    @Test
    void anUndocumentedRefusalLeavesTheReadUnexercised() throws Exception {
        Observation other = Observation.ofHttp(404, "application/json", "{\"error\":\"nope\"}".getBytes(StandardCharsets.UTF_8));
        Check c = judge.mcp(KEY, TEMPLATE, true, compare(other, Observation.failure(404, "HTTP 404")));
        assertEquals(ReadJudge.UNEXERCISED, c.outcome());
        assertTrue(c.detail().contains("\"kind\": \"read-gate\""), c.detail());
    }

    @Test
    void aDifferentValueIsADivergence() throws Exception {
        Check c = judge.mcp(KEY, TEMPLATE, true, compare(json("{\"a\":1}"), json("{\"a\":2}")));
        assertEquals(ReadJudge.DIVERGENT, c.outcome());
        assertEquals("EQUIVALENT", judge.mcp(KEY, TEMPLATE, true, compare(json("{\"a\":1}"), json("{\"a\":1}"))).outcome());
    }

    @Test
    void adapterLagMustBeDocumentedAndSetOrderIsNotCompared() throws Exception {
        Check lagging = judge.adapter(KEY, "chain()", compare(json("{\"x\":1,\"y\":2}"), json("{\"y\":2}")), path -> false);
        assertEquals("DIVERGENT_DOCUMENTED", lagging.outcome());
        assertTrue(lagging.detail().startsWith("known-lag@2026-09-29"), lagging.detail());
        assertEquals(ReadJudge.DIVERGENT, judge.adapter(KEY, "chain()", compare(json("{\"y\":1}"), json("{\"y\":2}")), path -> false).outcome());
        Check unordered = judge.adapter(KEY, "chain()", compare(json("[{\"a\":1},{\"a\":2}]"), json("[{\"a\":2},{\"a\":1}]")), "$"::equals);
        assertEquals("EQUIVALENT", unordered.outcome());
        assertEquals(ReadJudge.DIVERGENT, judge.adapter(KEY, "chain()", compare(json("[1,2]"), json("[2,1]")), path -> false).outcome());
    }

    private static ReadComparison compare(Observation reference, Observation subject) throws Exception {
        return ReadComparison.run(() -> reference, () -> subject, v -> v, 1);
    }

    private static Observation json(String body) {
        return Observation.ofHttp(200, "application/json", body.getBytes(StandardCharsets.UTF_8));
    }
}
