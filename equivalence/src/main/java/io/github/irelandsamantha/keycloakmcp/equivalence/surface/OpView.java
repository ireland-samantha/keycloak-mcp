package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.CatalogOp;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Source-neutral projection of one operation (method + name-free path) so any two surfaces can be diffed with the
 * same code. For the admin client, all overloads/chains that hit the same operation are merged (unions), and
 * each contributing Java chain is kept in {@link #bindings()}.
 *
 * @param formParams {@code null} when the source does not describe form fields
 */
public record OpView(
        String key,
        String method,
        String path,
        List<String> pathParams,
        List<String> tags,
        Set<String> queryParams,
        Set<String> pathLevelQueryParams,
        Set<String> formParams,
        Set<String> consumes,
        Set<String> produces,
        List<String> bindings) {

    public static Map<String, OpView> fromCatalog(List<CatalogOp> ops) {
        Map<String, OpView> out = new LinkedHashMap<>();
        ops.stream().sorted(Comparator.comparing(CatalogOp::key)).forEach(op -> {
            OpView v = new OpView(op.key(), op.method(), op.path(), op.pathParams(), op.tags(), op.queryParams(),
                    op.pathLevelQueryParams(), op.formParams(), media(op.consumes()), media(op.produces()),
                    List.of(op.path()));
            OpView prev = out.putIfAbsent(v.key(), v);
            if (prev != null) {
                // Two catalog paths that differ only by parameter names collide; keep both visible.
                out.put(v.key(), prev.mergeCatalogDuplicate(v));
            }
        });
        return out;
    }

    public static Map<String, OpView> fromAdminClient(List<Endpoint> endpoints) {
        Map<String, List<Endpoint>> byKey = endpoints.stream()
                .collect(Collectors.groupingBy(Endpoint::key, TreeMap::new, Collectors.toList()));
        Map<String, OpView> out = new LinkedHashMap<>();
        byKey.forEach((key, group) -> {
            Endpoint first = group.getFirst();
            out.put(key, new OpView(
                    key,
                    first.httpMethod(),
                    first.pathTemplate(),
                    first.pathParams(),
                    group.stream().map(e -> simpleName(e.terminal().resource())).distinct().sorted().toList(),
                    union(group, e -> names(e, ParamSpec.Source.QUERY)),
                    Set.of(),
                    union(group, e -> names(e, ParamSpec.Source.FORM)),
                    media(union(group, e -> sendsEntity(e) ? new TreeSet<>(e.consumes()) : Set.of())),
                    media(union(group, e -> new TreeSet<>(e.produces()))),
                    group.stream().map(e -> e.javaChain() + " -> " + e.returnKind() + (e.deprecated() ? " @Deprecated" : ""))
                            .toList()));
        });
        return out;
    }

    /** {@code @Consumes} only matters when the binding actually transmits a body or form. */
    private static boolean sendsEntity(Endpoint e) {
        return !e.params(ParamSpec.Source.BODY).isEmpty() || !e.params(ParamSpec.Source.FORM).isEmpty();
    }

    /** Path templates that differ only in variable names share a key; surface both paths as bindings. */
    private OpView mergeCatalogDuplicate(OpView other) {
        List<String> b = new ArrayList<>(bindings);
        b.addAll(other.bindings);
        return new OpView(key, method, path, pathParams, tags, queryParams, pathLevelQueryParams, formParams,
                consumes, produces, List.copyOf(b));
    }

    private static Set<String> names(Endpoint e, ParamSpec.Source source) {
        return e.params(source).stream().map(ParamSpec::name).collect(Collectors.toCollection(TreeSet::new));
    }

    private static Set<String> union(List<Endpoint> group, Function<Endpoint, Set<String>> f) {
        Set<String> out = new TreeSet<>();
        group.forEach(e -> out.addAll(f.apply(e)));
        return out;
    }

    /** Media types compared case-insensitively and without parameters ({@code ;charset=...}). */
    static Set<String> media(Set<String> types) {
        return types.stream()
                .map(t -> t.split(";", 2)[0].strip().toLowerCase(Locale.ROOT))
                .filter(t -> !t.isEmpty())
                .collect(Collectors.toCollection(TreeSet::new));
    }

    private static String simpleName(String fqcn) {
        return fqcn.substring(fqcn.lastIndexOf('.') + 1);
    }
}
