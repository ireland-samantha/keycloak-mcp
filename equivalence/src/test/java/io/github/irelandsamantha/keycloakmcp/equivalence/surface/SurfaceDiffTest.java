package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SurfaceDiffTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    static final String OPENAPI = """
            {"paths": {
              "/r/{realm}/res/{resource-id}": {
                "parameters": [{"name":"realm","in":"path"},{"name":"resource-id","in":"path"},{"name":"deep","in":"query"}],
                "get":    {"tags":["Authz"],"parameters":[{"name":"fields","in":"query"}],
                           "responses":{"200":{"content":{"application/json":{}}},"404":{"content":{"text/plain":{}}}}},
                "delete": {"tags":["Authz"],"responses":{"204":{}}}
              },
              "/r/{realm}/only-here": {"get": {"tags":["Extra"],"responses":{"200":{}}}}
            }}""";

    /** Operations as keycloak_describe_operation reports them: path-item parameters flattened into each one. */
    static final String MCP = """
            [
              {"method":"GET","path":"/r/{realm}/res/{resource-id}","tags":["Authz"],
               "parameters":[{"name":"realm","in":"path"},{"name":"resource-id","in":"path"},{"name":"deep","in":"query"},{"name":"fields","in":"query"}],
               "requestTypes":[],"responseTypes":["application/json","text/plain"]},
              {"method":"DELETE","path":"/r/{realm}/res/{resource-id}","tags":["Authz"],
               "parameters":[{"name":"deep","in":"query"}],"requestTypes":[],"responseTypes":[]}
            ]""";

    @Test
    void pathLevelParametersAreKeptApartAndComparedSymmetrically() throws Exception {
        Map<String, OpView> oa = OpView.fromCatalog(OpenApiCatalog.parse(JSON.readTree(OPENAPI)));
        Map<String, OpView> mcp = OpView.fromCatalog(McpCatalog.parse(JSON.readTree(MCP)));

        OpView del = oa.get("DELETE /r/{}/res/{}");
        assertEquals(Set.of(), del.queryParams());
        assertEquals(Set.of("deep"), del.pathLevelQueryParams());

        SurfaceDiff.Result r = SurfaceDiff.compare("oa", oa, "mcp", mcp);
        assertEquals(new SurfaceDiff.Counts(3, 2, 2, 1, 0), r.counts());
        assertEquals(List.of(), r.queryParamDiffs(), "flattened path-level params are not a difference");
        assertEquals("GET /r/{}/only-here", r.onlyInLeft().getFirst().key());
        // OpenAPI keeps only 2xx media; the catalog digest keeps every response's media.
        SurfaceDiff.MediaDiff produces = r.mediaTypeDiffs().getFirst();
        assertEquals("left-subset", produces.relation());
    }

    @Test
    void operationLevelDifferencesAreReportedPerSide() throws Exception {
        Map<String, OpView> oa = OpView.fromCatalog(OpenApiCatalog.parse(JSON.readTree(OPENAPI)));
        OpView get = oa.get("GET /r/{}/res/{}");
        OpView trimmed = new OpView(get.key(), get.method(), get.path(), List.of("realm", "id"), get.tags(),
                Set.of("first"), Set.of(), null, get.consumes(), get.produces(), List.of("x"));
        SurfaceDiff.Result r = SurfaceDiff.compare("client", Map.of(trimmed.key(), trimmed), "oa", oa);
        SurfaceDiff.SetDiff q = r.queryParamDiffs().getFirst();
        assertEquals(Set.of("first"), q.onlyLeft());
        assertEquals(Set.of("fields"), q.onlyRight());
        assertEquals(Set.of("deep"), q.pathLevelOnlyRight());
        assertTrue(r.pathParamNameDiffs().getFirst().right().contains("resource-id"));
    }
}
