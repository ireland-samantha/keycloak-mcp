package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.CatalogOp;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * Reads keycloak-mcp catalog operations as {@code keycloak_describe_operation} reports them
 * ({@code {method, path, tags, parameters:[{name, in}], requestTypes, responseTypes}}).
 * keycloak-mcp flattens OpenAPI path-item parameters into each operation, so
 * {@link CatalogOp#pathLevelQueryParams()} is empty and hoisted OpenAPI parameters appear as ordinary query
 * parameters; form fields are not described ({@code null}).
 */
public final class McpCatalog {

    private McpCatalog() {
    }

    public static List<CatalogOp> parse(Iterable<JsonNode> described) {
        List<CatalogOp> ops = new ArrayList<>();
        for (JsonNode op : described) {
            List<String> declaredPath = new ArrayList<>();
            Set<String> query = new TreeSet<>();
            op.path("parameters").forEach(p -> {
                switch (p.path("in").asText()) {
                    case "path" -> declaredPath.add(p.path("name").asText());
                    case "query" -> query.add(p.path("name").asText());
                    default -> { }
                }
            });
            ops.add(new CatalogOp(
                    op.path("method").asText().toUpperCase(Locale.ROOT),
                    op.path("path").asText(),
                    List.copyOf(declaredPath),
                    Json.texts(op.path("tags")),
                    query,
                    Set.of(),
                    null,
                    new TreeSet<>(Json.texts(op.path("requestTypes"))),
                    new TreeSet<>(Json.texts(op.path("responseTypes")))));
        }
        return ops;
    }
}
