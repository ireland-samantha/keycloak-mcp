package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class KnownLagTest {

    private final KnownLag lag = KnownLag.parse(Json.read("""
            {"lag": [
              {"key": "GET /admin/realms/{realm}/organizations", "path": "$[*].domains[*].autoRedirect",
               "kind": "MISSING_RIGHT", "reason": "adapter drops it", "evidence": "X.java:1", "since": "2026-09-29"}
            ]}""".getBytes()));

    @Test
    void documentsOnlyTheSameOperationPathAndKind() {
        JsonDiff.Diff dropped = new JsonDiff.Diff("$[0].domains[1].autoRedirect", JsonDiff.Kind.MISSING_RIGHT, "false", "<absent>");
        JsonDiff.Diff added = new JsonDiff.Diff("$[0].domains[1].autoRedirect", JsonDiff.Kind.MISSING_LEFT, "<absent>", "false");
        KnownLag.Assessment a = lag.assess("GET /admin/realms/{}/organizations", List.of(dropped, added));
        assertEquals(List.of(dropped), List.copyOf(a.documented().keySet()));
        assertEquals(List.of(added), a.undocumented());
        assertEquals(List.of(dropped), lag.assess("GET /admin/realms/{}/other", List.of(dropped)).undocumented());
        assertEquals(List.of(), lag.unused());
    }

    @Test
    void anEntryMustBeDated() {
        assertThrows(RuntimeException.class, () -> KnownLag.parse(Json.read("""
                {"lag": [{"key": "GET /a", "path": "$", "kind": "VALUE", "reason": "r", "evidence": "e", "since": "soon"}]}
                """.getBytes())));
    }
}
