package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.fixture.Fixtures;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JaxRsSurfaceWalkerTest {

    static WalkResult walk;
    static Map<String, List<Endpoint>> byKey;

    @BeforeAll
    static void walkFixtures() {
        walk = new JaxRsSurfaceWalker().walk(Fixtures.ALL);
        byKey = walk.endpoints().stream().collect(Collectors.groupingBy(Endpoint::key));
    }

    @Test
    void rootsAreInterfacesWithClassLevelPath() {
        assertEquals(List.of(Fixtures.PrefixedResource.class.getName(), Fixtures.RootResource.class.getName()), walk.roots());
        assertEquals(List.of(Fixtures.Orphan.class.getName()), walk.unreachableResources());
    }

    @Test
    void overloadsCollapseIntoOneOperation() {
        assertEquals(2, byKey.get("GET /api").size());
        OpView op = OpView.fromAdminClient(walk.endpoints()).get("GET /api");
        assertEquals(Set.of("brief", "first"), op.queryParams());
    }

    @Test
    void cyclesAreCutAndReported() {
        assertFalse(byKey.containsKey("GET /api/items/{}/children/{}"));
        assertEquals(2, walk.cycles().size(), walk.cycles().toString());
        assertTrue(walk.cycles().stream().anyMatch(c -> c.startsWith("ItemResource#child(String)")));
        assertTrue(walk.cycles().stream().anyMatch(c -> c.startsWith("ItemResource#up()")));
    }

    @Test
    void regexTemplateAndCustomVerb() {
        assertEquals("/api/tree/{path}", byKey.get("GET /api/tree/{}").getFirst().pathTemplate());
        assertTrue(byKey.containsKey("PROPFIND /api/dav"));
    }

    @Test
    void subResourceClassLevelPathIsAppendedLikeTheClientProxy() {
        assertTrue(byKey.containsKey("GET /api/prefixed/inner"), byKey.keySet().toString());
        assertTrue(byKey.containsKey("GET /inner"), "also a root in its own right");
    }

    @Test
    void repeatedVariableNamesArePreservedInOrder() {
        Endpoint note = byKey.get("GET /api/items/{}/notes/{}").getFirst();
        assertEquals(List.of("id", "id"), note.pathParams());
        assertEquals("item(String).note(String).read()", note.javaChain());
    }

    @Test
    void mediaTypesInheritFromDeclaringInterface() {
        Endpoint create = byKey.get("POST /api").getFirst();
        assertEquals(List.of("application/json", "application/yaml"), create.consumes());
        assertEquals(List.of("application/json"), create.produces());
        assertEquals(Endpoint.ReturnKind.RESPONSE, create.returnKind());
        assertEquals(List.of(), byKey.get("GET /api/items/{}/notes/{}").getFirst().produces());
    }

    @Test
    void formPrimitiveAndBodyParametersAreClassified() {
        Endpoint form = byKey.get("POST /api/form").getFirst();
        assertEquals(List.of("a", "b"), form.params(ParamSpec.Source.FORM).stream().map(ParamSpec::name).toList());
        ParamSpec brief = byKey.get("GET /api").stream().flatMap(e -> e.params(ParamSpec.Source.QUERY).stream())
                .filter(p -> p.name().equals("brief")).findFirst().orElseThrow();
        assertTrue(brief.primitive());
        assertEquals("java.util.Map<java.lang.String, java.lang.Object>",
                byKey.get("POST /api").getFirst().params(ParamSpec.Source.BODY).getFirst().javaType());
    }

    @Test
    void defaultMethodsAreConveniencesAndLocatorQueryParamsAreAnomalies() {
        assertEquals(List.of("RootResource#firstPage()"), walk.conveniences());
        assertTrue(walk.anomalies().stream().anyMatch(a -> a.contains("Locator parameter ignored") && a.contains("QUERY q")),
                walk.anomalies().toString());
    }
}
