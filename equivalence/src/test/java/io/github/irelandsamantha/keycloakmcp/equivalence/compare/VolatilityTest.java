package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class VolatilityTest {

    private static final String KEY = "GET /admin/realms/{}/things";

    private final Volatility volatility = Volatility.parse(Json.read(("""
            {"volatile": [
              {"key": "GET /admin/realms/{realm}/things", "path": "$[*].at", "reason": "clock", "evidence": "X.java:1"},
              {"key": "GET /admin/realms/{realm}/things", "path": "$[*].xml", "pattern": "ID=\\"[^\\"]*\\"", "reason": "ids", "evidence": "X.java:2"},
              {"key": "GET /admin/realms/{realm}/other", "path": "$.at", "reason": "clock", "evidence": "X.java:3"}
            ]}""").getBytes()));

    @Test
    void masksDocumentedValuesOfTheOperationOnly() {
        JsonNode masked = volatility.mask(KEY, Json.read("[{\"at\":1,\"xml\":\"<a ID=\\\"x1\\\" b=\\\"c\\\"/>\",\"keep\":2}]".getBytes()));
        assertEquals("[{\"at\":\"<volatile>\",\"xml\":\"<a <volatile> b=\\\"c\\\"/>\",\"keep\":2}]", masked.toString());
        JsonNode other = Json.read("[{\"at\":1}]".getBytes());
        assertEquals(other, volatility.mask("GET /admin/realms/{}/unrelated", other));
    }

    @Test
    void entriesThatNeverMaskedAnythingAreUnused() {
        volatility.mask(KEY, Json.read("[{\"at\":1}]".getBytes()));
        assertEquals(2, volatility.unused().size());
    }
}
