package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * Structural diff of two operation surfaces keyed by {@code "METHOD /name/free/{}/path"}.
 * Pure function of its inputs; ordering of every list in the result is deterministic.
 */
public final class SurfaceDiff {

    private SurfaceDiff() {
    }

    public record Counts(int left, int right, int matched, int onlyLeft, int onlyRight) {
    }

    public record Missing(String key, String path, List<String> tags, List<String> bindings) {
    }

    public record NameDiff(String key, List<String> left, List<String> right) {
    }

    /**
     * {@code onlyLeft}/{@code onlyRight}: declared at operation level on one side and nowhere on the other.
     * {@code pathLevelOnlyLeft}/{@code pathLevelOnlyRight}: declared on one side only via an OpenAPI path item
     * (hoisted, often not honoured by the concrete method) and absent at operation level on the other side.
     */
    public record SetDiff(String key, Set<String> onlyLeft, Set<String> onlyRight,
                          Set<String> pathLevelOnlyLeft, Set<String> pathLevelOnlyRight) {
    }

    /**
     * relation: {@code left-undeclared}/{@code right-undeclared} (one side empty), {@code left-subset},
     * {@code right-subset}, {@code overlap}, {@code disjoint}.
     */
    public record MediaDiff(String key, String aspect, Set<String> left, Set<String> right, String relation) {
    }

    public record Result(
            String left,
            String right,
            Counts counts,
            List<Missing> onlyInLeft,
            List<Missing> onlyInRight,
            List<NameDiff> pathParamNameDiffs,
            List<SetDiff> queryParamDiffs,
            List<SetDiff> formParamDiffs,
            List<MediaDiff> mediaTypeDiffs) {
    }

    public static Result compare(String leftName, Map<String, OpView> left, String rightName, Map<String, OpView> right) {
        List<Missing> onlyLeft = new ArrayList<>();
        List<Missing> onlyRight = new ArrayList<>();
        List<NameDiff> names = new ArrayList<>();
        List<SetDiff> query = new ArrayList<>();
        List<SetDiff> form = new ArrayList<>();
        List<MediaDiff> media = new ArrayList<>();
        int matched = 0;

        for (OpView l : left.values()) {
            OpView r = right.get(l.key());
            if (r == null) {
                onlyLeft.add(missing(l));
                continue;
            }
            matched++;
            if (!l.pathParams().equals(r.pathParams())) {
                names.add(new NameDiff(l.key(), l.pathParams(), r.pathParams()));
            }
            setDiff(l.key(), l.queryParams(), l.pathLevelQueryParams(), r.queryParams(), r.pathLevelQueryParams())
                    .ifPresent(query::add);
            if (l.formParams() != null && r.formParams() != null) {
                setDiff(l.key(), l.formParams(), Set.of(), r.formParams(), Set.of()).ifPresent(form::add);
            }
            mediaDiff(l.key(), "consumes", l.consumes(), r.consumes()).ifPresent(media::add);
            mediaDiff(l.key(), "produces", l.produces(), r.produces()).ifPresent(media::add);
        }
        for (OpView r : right.values()) {
            if (!left.containsKey(r.key())) {
                onlyRight.add(missing(r));
            }
        }
        return new Result(leftName, rightName,
                new Counts(left.size(), right.size(), matched, onlyLeft.size(), onlyRight.size()),
                List.copyOf(onlyLeft), List.copyOf(onlyRight), List.copyOf(names), List.copyOf(query),
                List.copyOf(form), List.copyOf(media));
    }

    private static Missing missing(OpView v) {
        return new Missing(v.key(), v.path(), v.tags(), v.bindings());
    }

    private static Optional<SetDiff> setDiff(String key, Set<String> lOp, Set<String> lPath,
                                             Set<String> rOp, Set<String> rPath) {
        Set<String> onlyL = minus(minus(lOp, rOp), rPath);
        Set<String> onlyR = minus(minus(rOp, lOp), lPath);
        Set<String> pathOnlyL = minus(minus(lPath, rOp), rPath);
        Set<String> pathOnlyR = minus(minus(rPath, lOp), lPath);
        if (onlyL.isEmpty() && onlyR.isEmpty() && pathOnlyL.isEmpty() && pathOnlyR.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(new SetDiff(key, onlyL, onlyR, pathOnlyL, pathOnlyR));
    }

    private static Optional<MediaDiff> mediaDiff(String key, String aspect, Set<String> l, Set<String> r) {
        if (Objects.equals(l, r)) {
            return Optional.empty();
        }
        String relation;
        if (l.isEmpty()) {
            relation = "left-undeclared";
        } else if (r.isEmpty()) {
            relation = "right-undeclared";
        } else if (r.containsAll(l)) {
            relation = "left-subset";
        } else if (l.containsAll(r)) {
            relation = "right-subset";
        } else if (l.stream().anyMatch(r::contains)) {
            relation = "overlap";
        } else {
            relation = "disjoint";
        }
        return Optional.of(new MediaDiff(key, aspect, l, r, relation));
    }

    private static Set<String> minus(Set<String> a, Set<String> b) {
        Set<String> out = new TreeSet<>(a);
        out.removeAll(b);
        return out;
    }
}
