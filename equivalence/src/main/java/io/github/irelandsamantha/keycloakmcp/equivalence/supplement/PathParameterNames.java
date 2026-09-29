package io.github.irelandsamantha.keycloakmcp.equivalence.supplement;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Renames the path variables of an admin-client template the way keycloak-mcp's catalog needs them: a variable
 * shared with a documented OpenAPI path takes the OpenAPI name (so {@code /clients/{client-uuid}} reads the same
 * across catalog versions), any other keeps the Java {@code @PathParam} name, and names are made unique within the
 * path because keycloak-mcp binds path values by name (admin-client chains repeat {@code {id}}).
 */
final class PathParameterNames {

    private final List<List<String>> openApiTemplates;

    PathParameterNames(Collection<String> openApiPaths) {
        this.openApiTemplates = openApiPaths.stream().map(PathParameterNames::segments).toList();
    }

    String harmonize(String template) {
        List<String> segments = segments(template);
        Set<String> used = new HashSet<>();
        List<String> out = new ArrayList<>(segments.size());
        for (int i = 0; i < segments.size(); i++) {
            String segment = segments.get(i);
            if (!isVariable(segment)) {
                out.add(segment);
                continue;
            }
            String name = documentedName(segments, i);
            if (name == null) {
                name = PathTemplates.variableNames(segment).getFirst();
            }
            if (!used.add(name)) {
                name = segments.get(i - 1) + "-" + name;
                if (!used.add(name)) {
                    throw new IllegalStateException("Cannot give " + template + " unique path variable names");
                }
            }
            out.add("{" + name + "}");
        }
        return "/" + String.join("/", out);
    }

    /** The most common OpenAPI name for the variable at {@code index}, among paths sharing everything before it. */
    private String documentedName(List<String> segments, int index) {
        Map<String, Long> names = openApiTemplates.stream()
                .filter(t -> t.size() > index && isVariable(t.get(index)) && samePrefix(t, segments, index))
                .map(t -> PathTemplates.variableNames(t.get(index)).getFirst())
                .collect(Collectors.groupingBy(Function.identity(), Collectors.counting()));
        return names.entrySet().stream()
                .max(Map.Entry.<String, Long>comparingByValue().thenComparing(Map.Entry.comparingByKey(Comparator.reverseOrder())))
                .map(Map.Entry::getKey)
                .orElse(null);
    }

    private static boolean samePrefix(List<String> a, List<String> b, int length) {
        for (int i = 0; i < length; i++) {
            if (!normalized(a.get(i)).equals(normalized(b.get(i)))) {
                return false;
            }
        }
        return true;
    }

    private static List<String> segments(String template) {
        return List.of(PathTemplates.stripRegex(template).replaceFirst("^/", "").split("/"));
    }

    private static boolean isVariable(String segment) {
        return segment.startsWith("{") && segment.endsWith("}");
    }

    private static String normalized(String segment) {
        return isVariable(segment) ? "{}" : segment;
    }
}
