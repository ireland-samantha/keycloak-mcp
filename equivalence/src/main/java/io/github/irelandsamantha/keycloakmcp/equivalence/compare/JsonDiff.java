package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Structural JSON diff that classifies differences instead of normalising them away, so each check decides which
 * kinds it tolerates (e.g. {@link Kind#KEY_ORDER}) and which defeat equivalence.
 */
public final class JsonDiff {

    public enum Kind {
        MISSING_LEFT, MISSING_RIGHT, TYPE, VALUE,
        /** Different decimal values that collapse to the same IEEE double: a JavaScript Number round-trip. */
        NUMBER_PRECISION,
        /** Same value, different spelling ({@code 1} vs {@code 1.0}, {@code 1e2} vs {@code 100}). */
        NUMBER_FORMAT,
        ARRAY_LENGTH,
        /** Same elements (up to key order) in a different order. */
        ARRAY_ORDER,
        KEY_ORDER
    }

    public record Diff(String path, Kind kind, String left, String right) {
        @Override
        public String toString() {
            return kind + " " + path + " left=" + left + " right=" + right;
        }
    }

    private static final int PREVIEW = 120;

    private JsonDiff() {
    }

    public static List<Diff> diff(JsonNode left, JsonNode right) {
        List<Diff> out = new ArrayList<>();
        walk("$", left, right, out);
        return out;
    }

    private static void walk(String path, JsonNode l, JsonNode r, List<Diff> out) {
        if (l == null && r == null) {
            return;
        }
        if (l == null || r == null) {
            out.add(new Diff(path, l == null ? Kind.MISSING_LEFT : Kind.MISSING_RIGHT, preview(l), preview(r)));
        } else if (l.isNumber() && r.isNumber()) {
            numbers(path, l, r, out);
        } else if (l.getNodeType() != r.getNodeType()) {
            out.add(new Diff(path, Kind.TYPE, preview(l), preview(r)));
        } else if (l.isObject()) {
            objects(path, l, r, out);
        } else if (l.isArray()) {
            arrays(path, l, r, out);
        } else if (!l.equals(r)) {
            out.add(new Diff(path, Kind.VALUE, preview(l), preview(r)));
        }
    }

    private static void numbers(String path, JsonNode l, JsonNode r, List<Diff> out) {
        BigDecimal a = l.decimalValue();
        BigDecimal b = r.decimalValue();
        if (a.compareTo(b) != 0) {
            boolean doubleExplains = new BigDecimal(a.doubleValue()).compareTo(new BigDecimal(b.doubleValue())) == 0;
            out.add(new Diff(path, doubleExplains ? Kind.NUMBER_PRECISION : Kind.VALUE, preview(l), preview(r)));
        } else if (!l.asText().equals(r.asText()) || l.isIntegralNumber() != r.isIntegralNumber()) {
            out.add(new Diff(path, Kind.NUMBER_FORMAT, preview(l), preview(r)));
        }
    }

    private static void objects(String path, JsonNode l, JsonNode r, List<Diff> out) {
        List<String> leftKeys = new ArrayList<>();
        l.fieldNames().forEachRemaining(leftKeys::add);
        List<String> rightKeys = new ArrayList<>();
        r.fieldNames().forEachRemaining(rightKeys::add);
        Set<String> all = new LinkedHashSet<>(leftKeys);
        all.addAll(rightKeys);
        for (String k : all) {
            walk(path + "." + k, l.get(k), r.get(k), out);
        }
        List<String> leftCommon = new ArrayList<>(leftKeys);
        leftCommon.retainAll(rightKeys);
        List<String> rightCommon = new ArrayList<>(rightKeys);
        rightCommon.retainAll(leftKeys);
        if (!leftCommon.equals(rightCommon)) {
            out.add(new Diff(path, Kind.KEY_ORDER, leftCommon.toString(), rightCommon.toString()));
        }
    }

    private static void arrays(String path, JsonNode l, JsonNode r, List<Diff> out) {
        if (l.size() != r.size()) {
            out.add(new Diff(path, Kind.ARRAY_LENGTH, String.valueOf(l.size()), String.valueOf(r.size())));
        }
        List<Diff> inner = new ArrayList<>();
        for (int i = 0; i < Math.min(l.size(), r.size()); i++) {
            walk(path + "[" + i + "]", l.get(i), r.get(i), inner);
        }
        if (!inner.isEmpty() && l.size() == r.size() && sameMultiset(l, r)) {
            out.add(new Diff(path, Kind.ARRAY_ORDER, "same elements", "different order"));
        } else {
            out.addAll(inner);
        }
    }

    /** Equal as multisets when each element matches one on the other side up to key order. */
    private static boolean sameMultiset(JsonNode l, JsonNode r) {
        List<JsonNode> rest = new ArrayList<>();
        r.forEach(rest::add);
        for (JsonNode x : l) {
            int match = -1;
            for (int i = 0; i < rest.size() && match < 0; i++) {
                if (diff(x, rest.get(i)).stream().allMatch(d -> d.kind() == Kind.KEY_ORDER)) {
                    match = i;
                }
            }
            if (match < 0) {
                return false;
            }
            rest.remove(match);
        }
        return rest.isEmpty();
    }

    private static String preview(JsonNode n) {
        if (n == null) {
            return "<absent>";
        }
        String t = n.toString();
        return t.length() > PREVIEW ? t.substring(0, PREVIEW - 3) + "..." : t;
    }
}
