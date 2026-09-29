package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.CatalogOp;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Loads an OpenAPI 3 document into {@link CatalogOp}s. Path-item level parameters are kept apart from
 * operation-level ones: Keycloak's generated document hoists locator-scoped query parameters (e.g. the
 * authz {@code resource} search filters) onto the path item, which then "applies" them to unrelated
 * methods such as {@code DELETE}; callers decide how much weight to give them.
 */
public final class OpenApiCatalog {

    private static final Set<String> METHODS = Set.of("get", "put", "post", "delete", "patch", "head", "options", "trace");
    private static final Set<String> FORM_TYPES = Set.of("application/x-www-form-urlencoded", "multipart/form-data");

    private OpenApiCatalog() {
    }

    public static List<CatalogOp> parse(JsonNode doc) {
        List<CatalogOp> ops = new ArrayList<>();
        for (Map.Entry<String, JsonNode> item : doc.path("paths").properties()) {
            String path = item.getKey();
            JsonNode pathItem = item.getValue();
            Set<String> pathLevelQuery = new TreeSet<>(namesIn(pathItem.path("parameters"), "query"));
            for (Map.Entry<String, JsonNode> e : pathItem.properties()) {
                if (!METHODS.contains(e.getKey())) {
                    continue;
                }
                JsonNode op = e.getValue();
                Set<String> opQuery = new TreeSet<>(namesIn(op.path("parameters"), "query"));
                Set<String> inherited = new TreeSet<>(pathLevelQuery);
                inherited.removeAll(opQuery);
                List<String> declaredPath = new ArrayList<>(namesIn(pathItem.path("parameters"), "path"));
                namesIn(op.path("parameters"), "path").stream().filter(n -> !declaredPath.contains(n)).forEach(declaredPath::add);
                ops.add(new CatalogOp(
                        e.getKey().toUpperCase(Locale.ROOT),
                        path,
                        List.copyOf(declaredPath),
                        Json.texts(op.path("tags")),
                        opQuery,
                        inherited,
                        formFields(doc, op.path("requestBody").path("content")),
                        Json.fieldNames(op.path("requestBody").path("content")),
                        successContentTypes(op.path("responses"))));
            }
        }
        return ops;
    }

    private static Set<String> formFields(JsonNode doc, JsonNode content) {
        Set<String> out = new TreeSet<>();
        content.properties().forEach(c -> {
            if (FORM_TYPES.contains(c.getKey())) {
                out.addAll(Json.fieldNames(resolve(doc, c.getValue().path("schema")).path("properties")));
            }
        });
        return out;
    }

    /** Follows a local {@code $ref} ("#/components/schemas/X") once. */
    private static JsonNode resolve(JsonNode doc, JsonNode schema) {
        String ref = schema.path("$ref").asText("");
        return ref.startsWith("#/") ? doc.at(ref.substring(1)) : schema;
    }

    private static Set<String> successContentTypes(JsonNode responses) {
        Set<String> out = new TreeSet<>();
        responses.properties().forEach(r -> {
            String code = r.getKey();
            if (code.startsWith("2") || code.equals("default")) {
                out.addAll(Json.fieldNames(r.getValue().path("content")));
            }
        });
        return out;
    }

    /** Parameter names of one location, in declaration order. */
    private static Set<String> namesIn(JsonNode params, String in) {
        Set<String> out = new LinkedHashSet<>();
        params.forEach(p -> {
            if (in.equals(p.path("in").asText())) {
                out.add(p.path("name").asText());
            }
        });
        return out;
    }
}
