package io.github.irelandsamantha.keycloakmcp.equivalence.supplement;

import com.fasterxml.jackson.core.type.TypeReference;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class JsonSchemasTest {

    public enum Level { LOW, HIGH }

    public static class Documented {
        public String id;
    }

    public static class Undocumented {
        public Level level;
        public Set<String> names;
        public Map<String, Integer> counts;
        public Documented documented;
        public Undocumented parent;
    }

    private final JsonSchemas schemas = new JsonSchemas(Set.of("Documented"));

    @Test
    void entitiesWithoutJsonBodyHaveNoSchema() {
        assertNull(schemas.entity(void.class));
        assertNull(schemas.entity(Response.class));
        assertEquals(Map.of("type", "string"), schemas.entity(String.class));
    }

    @Test
    void documentedRepresentationsAreReferencedNotCopied() {
        assertEquals(Map.of("type", "array", "items", Map.of("$ref", "#/components/schemas/Documented")),
                schemas.entity(new TypeReference<List<Documented>>() { }.getType()));
        assertEquals(Map.of(), schemas.generated());
    }

    @Test
    void undocumentedRepresentationsAreGeneratedFromTheirJsonProperties() {
        assertEquals(Map.of("$ref", "#/components/schemas/Undocumented"), schemas.entity(Undocumented.class));
        assertEquals(Map.of("type", "object", "properties", Map.of(
                "level", Map.of("type", "string", "enum", List.of("LOW", "HIGH")),
                "names", Map.of("type", "array", "items", Map.of("type", "string"), "uniqueItems", true),
                "counts", Map.of("type", "object", "additionalProperties", Map.of("type", "integer", "format", "int32")),
                "documented", Map.of("$ref", "#/components/schemas/Documented"),
                "parent", Map.of("$ref", "#/components/schemas/Undocumented"))),
                schemas.generated().get("Undocumented"));
    }
}
