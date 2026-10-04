package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class NormalizationTest {

    private static final Map<String, String> IDS = Map.of("role:writer", "id-1", "role:default-roles-twin-a", "id-2",
            "realm", "id-3");

    @Test
    void generatedIdsBecomeNaturalKeysInValuesAndKeys() {
        JsonNode normalized = new Normalization("twin-a", IDS, List.of()).apply(Json.read("""
                {"id": "id-1", "containerId": "id-3", "byId": {"id-2": true}, "count": 2}"""));
        assertEquals(Json.read("""
                {"id": "<role:writer>", "containerId": "<realm>", "byId": {"<role:default-roles-<realm>>": true}, "count": 2}"""),
                normalized);
    }

    @Test
    void theRealmNameBecomesAPlaceholderInsideAnyString() {
        assertEquals(Json.read("""
                ["default-roles-<realm>", "unrelated"]"""),
                new Normalization("twin-a", Map.of(), List.of()).apply(Json.read("""
                        ["default-roles-twin-a", "unrelated"]""")));
    }

    @Test
    void volatileValuesAreMasked() {
        assertEquals(Json.read("""
                [{"at": "<volatile>", "name": "x"}]"""),
                new Normalization("twin-a", Map.of(), List.of("$[*].at")).apply(Json.read("""
                        [{"at": 1790667029221, "name": "x"}]""")));
    }
}
