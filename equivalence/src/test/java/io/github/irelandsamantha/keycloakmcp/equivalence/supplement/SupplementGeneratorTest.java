package io.github.irelandsamantha.keycloakmcp.equivalence.supplement;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.JaxRsSurfaceWalker;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.fixture.Fixtures;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class SupplementGeneratorTest {

    private static final String OPENAPI = """
            {"paths": {
              "/api": {"get": {"tags": ["Root"]}},
              "/api/items/{item-id}": {"get": {"tags": ["Items"]}}
            }, "components": {"schemas": {}}}""";

    static List<SupplementGenerator.Operation> generated;
    static Map<String, SupplementGenerator.Operation> operations;

    @BeforeAll
    static void generate() throws Exception {
        generated = new SupplementGenerator(new ObjectMapper().readTree(OPENAPI), new JaxRsSurfaceWalker().walk(Fixtures.ALL))
                .operations();
        operations = generated.stream().collect(Collectors.toMap(SupplementGenerator.Operation::key, Function.identity()));
    }

    @Test
    void onlyOperationsTheOpenApiLacksAreSupplementedSortedByKey() {
        assertFalse(operations.containsKey("GET /api"));
        assertFalse(operations.containsKey("GET /api/items/{item-id}"));
        List<String> keys = generated.stream().map(SupplementGenerator.Operation::key).toList();
        assertEquals(keys.stream().sorted().toList(), keys);
    }

    @Test
    void operationsReadLikeTheirDocumentedSiblings() {
        SupplementGenerator.Operation note = operations.get("GET /api/items/{item-id}/notes/{id}");
        assertEquals(List.of("Items"), note.tags());
        assertEquals(List.of(new SupplementGenerator.Parameter("item-id", "path", true, "string"),
                new SupplementGenerator.Parameter("id", "path", true, "string")), note.parameters());
        assertEquals(List.of("RootResource#item(String)", "ItemResource#note(String)", "NoteResource#read()"), note.adminClient());
        assertEquals("Note: read", note.summary());
    }

    @Test
    void overloadsContributeEveryQueryParameterAndFormsBecomeObjectSchemas() {
        SupplementGenerator.Operation form = operations.get("POST /api/form");
        assertEquals(List.of("application/x-www-form-urlencoded"), form.requestTypes());
        assertEquals(Map.of("type", "object", "properties", Map.of("a", Map.of("type", "string"), "b", Map.of("type", "string"))),
                form.requestSchema());
        SupplementGenerator.Operation create = operations.get("POST /api");
        assertEquals(List.of("application/json", "application/yaml"), create.requestTypes());
    }
}
