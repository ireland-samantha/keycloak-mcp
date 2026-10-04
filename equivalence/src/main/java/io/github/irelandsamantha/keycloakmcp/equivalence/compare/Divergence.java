package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.OpView;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.SurfaceDiff;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.CatalogOp;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * One observed disagreement between two sources about one operation, in a form that can be matched exactly against
 * a documented entry: if the disagreement changes shape, the documentation no longer applies.
 *
 * @param key      name-free operation key
 * @param path     the operation's template with names, for humans
 * @param kind     {@code query}, {@code form}, {@code consumes}, {@code produces}, {@code path-names},
 *                 {@code path-declaration} or {@code route}
 * @param sources  compared sources, e.g. {@code openapi~admin-client}
 * @param observed what each side declares that the other does not (sets), or each side's full set (media);
 *                 {@code <source>@path-item} holds OpenAPI path-item parameters
 */
public record Divergence(String key, String path, String kind, String sources, SortedMap<String, SortedSet<String>> observed) {

    public String method() {
        return key.substring(0, key.indexOf(' '));
    }

    /** {@code METHOD /named/{path}}, the form documented entries use. */
    public String namedKey() {
        return method() + " " + path;
    }

    /** Every parameter, form-field and media difference in a surface diff, as divergences. */
    public static List<Divergence> fromDiff(SurfaceDiff.Result diff, Map<String, OpView> left) {
        String sources = diff.left() + "~" + diff.right();
        List<Divergence> out = new ArrayList<>();
        for (SurfaceDiff.SetDiff q : diff.queryParamDiffs()) {
            out.add(sets(q, "query", sources, diff, left));
        }
        for (SurfaceDiff.SetDiff f : diff.formParamDiffs()) {
            out.add(sets(f, "form", sources, diff, left));
        }
        for (SurfaceDiff.MediaDiff m : diff.mediaTypeDiffs()) {
            SortedMap<String, SortedSet<String>> observed = new TreeMap<>();
            observed.put(diff.left(), new TreeSet<>(m.left()));
            observed.put(diff.right(), new TreeSet<>(m.right()));
            out.add(new Divergence(m.key(), left.get(m.key()).path(), m.aspect(), sources, observed));
        }
        return out;
    }

    /** Path-variable name differences, for sources that must agree on names (a catalog and what it digests). */
    public static List<Divergence> namesFromDiff(SurfaceDiff.Result diff, Map<String, OpView> left) {
        String sources = diff.left() + "~" + diff.right();
        return diff.pathParamNameDiffs().stream().map(n -> {
            SortedMap<String, SortedSet<String>> observed = new TreeMap<>();
            observed.put(diff.left(), new TreeSet<>(List.of(String.join(",", n.left()))));
            observed.put(diff.right(), new TreeSet<>(List.of(String.join(",", n.right()))));
            return new Divergence(n.key(), left.get(n.key()).path(), "path-names", sources, observed);
        }).toList();
    }

    /**
     * Catalog operations whose {@code in: path} parameters are not exactly their template variables, each once:
     * keycloak-mcp binds path values by name, so a missing, extra or repeated name makes an operation uncallable
     * or ambiguous.
     */
    public static List<Divergence> pathDeclarations(String source, List<CatalogOp> ops) {
        List<Divergence> out = new ArrayList<>();
        for (CatalogOp op : ops) {
            List<String> template = op.pathParams();
            List<String> declared = op.declaredPathParams();
            boolean unique = Set.copyOf(template).size() == template.size();
            if (!unique || declared.size() != template.size() || !Set.copyOf(declared).equals(Set.copyOf(template))) {
                SortedMap<String, SortedSet<String>> observed = new TreeMap<>();
                observed.put("template", new TreeSet<>(List.of(String.join(",", template))));
                observed.put("declared", new TreeSet<>(List.of(String.join(",", declared))));
                out.add(new Divergence(op.key(), op.path(), "path-declaration", source, observed));
            }
        }
        return out;
    }

    private static Divergence sets(SurfaceDiff.SetDiff d, String kind, String sources, SurfaceDiff.Result diff,
                                   Map<String, OpView> left) {
        SortedMap<String, SortedSet<String>> observed = new TreeMap<>();
        put(observed, diff.left(), d.onlyLeft());
        put(observed, diff.right(), d.onlyRight());
        put(observed, diff.left() + "@path-item", d.pathLevelOnlyLeft());
        put(observed, diff.right() + "@path-item", d.pathLevelOnlyRight());
        return new Divergence(d.key(), left.get(d.key()).path(), kind, sources, observed);
    }

    private static void put(SortedMap<String, SortedSet<String>> observed, String side, Set<String> values) {
        if (!values.isEmpty()) {
            observed.put(side, Collections.unmodifiableSortedSet(new TreeSet<>(values)));
        }
    }

    @Override
    public String toString() {
        return namedKey() + " [" + kind + ", " + sources + "] " + observed;
    }
}
