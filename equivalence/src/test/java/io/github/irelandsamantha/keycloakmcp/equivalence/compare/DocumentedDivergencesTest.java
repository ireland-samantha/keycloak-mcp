package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DocumentedDivergencesTest {

    private static final String FILE = """
            {"divergences": [
              {"key": "GET /admin/realms/{realm}/components", "kind": "query", "sources": "openapi~admin-client",
               "observed": {"openapi": ["providerId"]}, "reason": "adapter lags", "evidence": "X.java:1", "since": "2026-09-28"},
              {"key": "DELETE /admin/realms/{realm}/js/{id}", "kind": "route", "sources": "server",
               "reason": "feature gated", "evidence": "Y.java:2", "since": "2026-09-28"}
            ]}""";

    private static DocumentedDivergences load(String json) throws Exception {
        return DocumentedDivergences.parse(new ObjectMapper().readTree(json));
    }

    private static Divergence query(String path, String... openapiOnly) {
        SortedMap<String, SortedSet<String>> observed = new TreeMap<>(Map.of("openapi", new TreeSet<>(List.of(openapiOnly))));
        return new Divergence("GET " + path.replaceAll("\\{[^}]*}", "{}"), path, "query", "openapi~admin-client", observed);
    }

    @Test
    void anEntryDocumentsExactlyTheObservationItPins() throws Exception {
        DocumentedDivergences file = load(FILE);
        Divergence same = query("/admin/realms/{r}/components", "providerId");
        Divergence grown = query("/admin/realms/{r}/components", "providerId", "type");

        DocumentedDivergences.Assessment exact = file.assess(List.of(same), e -> e.kind().equals("query"));
        assertTrue(exact.clean());
        assertEquals("adapter lags", exact.documented().get(same).reason());

        DocumentedDivergences.Assessment changed = file.assess(List.of(grown), e -> e.kind().equals("query"));
        assertEquals(List.of(grown), changed.undocumented());
        assertEquals(1, changed.stale().size(), "the old entry no longer applies");
    }

    @Test
    void routeEntriesMatchAnyAnswerAndAreOnlyStaleWhenInScope() throws Exception {
        DocumentedDivergences file = load(FILE);
        SortedMap<String, SortedSet<String>> seen = new TreeMap<>(Map.of("server", new TreeSet<>(List.of("404 whatever"))));
        Divergence unrouted = new Divergence("DELETE /admin/realms/{}/js/{}", "/admin/realms/{realm}/js/{id}", "route", "server", seen);
        assertTrue(file.assess(List.of(unrouted), e -> e.kind().equals("route")).clean());
        assertEquals(List.of(), file.assess(List.of(), e -> false).stale());
    }

    @Test
    void entriesMustBeReasonedDatedAndPinned() {
        assertThrows(IllegalArgumentException.class, () -> load(FILE.replace("\"reason\": \"adapter lags\", ", "")));
        assertThrows(IllegalArgumentException.class, () -> load(FILE.replace("\"since\": \"2026-09-28\"}", "\"since\": \"soon\"}")));
        assertThrows(IllegalArgumentException.class, () -> load(FILE.replace("\"observed\": {\"openapi\": [\"providerId\"]}, ", "")));
    }

    @Test
    void theShippedFileIsValid() {
        DocumentedDivergences.load();
    }

    @Test
    void aMutationGateObservesNothingAndNamesTheEnvironment() throws Exception {
        String gate = """
                {"divergences": [{"key": "POST /admin/realms/{realm}/components", "kind": "mutation-gate", %s
                  "reason": "needs a directory", "evidence": "X.java:1", "since": "2026-09-29"}]}""";
        DocumentedDivergences file = load(gate.formatted("\"sources\": \"environment\","));
        assertEquals(List.of("POST /admin/realms/{}/components"),
                file.ofKind(DocumentedDivergences.MUTATION_GATE).stream().map(DocumentedDivergences.Entry::operationKey).toList());
        assertThrows(IllegalArgumentException.class, () -> load(gate.formatted("\"sources\": \"server\",")));
        assertThrows(IllegalArgumentException.class, () -> load(gate.formatted(
                "\"sources\": \"environment\", \"observed\": {\"server\": [\"x\"]},")));
        assertThrows(IllegalArgumentException.class, () -> load("""
                {"divergences": [{"key": "POST /admin/realms/{realm}/components", "kind": "mutation-gate",
                  "sources": "environment", "reason": "needs a directory", "since": "2026-09-29"}]}"""));
    }
}
