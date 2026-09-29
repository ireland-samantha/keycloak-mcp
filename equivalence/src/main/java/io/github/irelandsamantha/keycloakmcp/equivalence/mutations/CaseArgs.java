package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * The arguments of one request, in the form every side can send: path values by position (the realm's included),
 * query parameters and an optional JSON body.
 */
public record CaseArgs(List<String> pathValues, Map<String, String> query, JsonNode body) {

    /** keycloak-mcp pins this path variable itself; a request may not set it. */
    private static final String REALM_VARIABLE = "realm";

    public CaseArgs {
        pathValues = List.copyOf(pathValues);
        query = Collections.unmodifiableMap(new TreeMap<>(query));
    }

    /** Arguments with these path values, in path order, and nothing else. */
    public static CaseArgs path(String... values) {
        return new CaseArgs(List.of(values), Map.of(), null);
    }

    public CaseArgs withQuery(String name, String value) {
        Map<String, String> q = new TreeMap<>(query);
        q.put(name, value);
        return new CaseArgs(pathValues, q, body);
    }

    public CaseArgs withBody(JsonNode value) {
        return new CaseArgs(pathValues, query, value);
    }

    /** {@code keycloak_workflow} step arguments, path values named after the catalog template's variables. */
    public ObjectNode mcpArguments(String catalogTemplate) {
        List<String> names = PathTemplates.variableNames(catalogTemplate);
        requireArity(catalogTemplate, names.size());
        ObjectNode args = JsonNodeFactory.instance.objectNode();
        ObjectNode named = args.putObject("path");
        for (int i = 0; i < names.size(); i++) {
            if (!names.get(i).equals(REALM_VARIABLE)) {
                named.put(names.get(i), pathValues.get(i));
            }
        }
        if (!query.isEmpty()) {
            ObjectNode q = args.putObject("query");
            query.forEach(q::put);
        }
        if (body != null) {
            args.set("body", body);
        }
        return args;
    }

    /** Encoded path and query below the server root. */
    public String rawPathAndQuery(String template) {
        requireArity(template, PathTemplates.variableNames(template).size());
        String expanded = PathTemplates.expand(template, (position, v) -> RawHttp.segment(pathValues.get(position)));
        return query.isEmpty() ? expanded : expanded + "?" + query.entrySet().stream()
                .map(e -> RawHttp.segment(e.getKey()) + "=" + RawHttp.segment(e.getValue()))
                .collect(Collectors.joining("&"));
    }

    private void requireArity(String template, int variables) {
        if (variables != pathValues.size()) {
            throw new IllegalArgumentException(template + " has " + variables + " path variables, got values " + pathValues);
        }
    }
}
