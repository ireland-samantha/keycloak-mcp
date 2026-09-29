package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.function.UnaryOperator;

/**
 * Compares a subject's answer to a read (keycloak-mcp, the adapter) with the reference answer (raw HTTP), reading the
 * reference immediately before and after the subject. The subject is judged only against a reference that did not
 * change between those two reads (after masking documented {@link Volatility}); otherwise the server itself was
 * unstable (a concurrent realm, a clock) and the sandwich is repeated.
 *
 * <p>When both answers are 2xx, their content classes and values must agree up to {@link JsonDiff.Kind#KEY_ORDER};
 * numbers must agree exactly, so {@code NUMBER_PRECISION} and {@code NUMBER_FORMAT} count as differences. A side
 * that could not read a 2xx body the other read differs at {@code $}. When both are not 2xx, only the statuses are
 * compared: neither keycloak-mcp nor a typed adapter call returns the error body.
 *
 * @param differences  subject vs the first reference read, KEY_ORDER removed
 * @param instability  first vs second reference read, KEY_ORDER removed; empty when the reference was stable
 * @param attempts     sandwiches read until the reference was stable or attempts ran out
 */
public record ReadComparison(Observation reference, Observation subject, List<JsonDiff.Diff> differences,
                             List<JsonDiff.Diff> instability, int attempts) {

    /** One read, as the reference or the subject performs it. */
    @FunctionalInterface
    public interface Read {
        Observation perform() throws Exception;
    }

    public static ReadComparison run(Read reference, Read subject, UnaryOperator<JsonNode> mask, int maxAttempts)
            throws Exception {
        for (int attempt = 1; ; attempt++) {
            Observation before = reference.perform();
            Observation observed = subject.perform();
            Observation after = reference.perform();
            List<JsonDiff.Diff> instability = compare(before, after, mask);
            if (instability.isEmpty() || attempt == maxAttempts) {
                return new ReadComparison(before, observed, compare(before, observed, mask), instability, attempt);
            }
        }
    }

    public boolean referenceStable() {
        return instability.isEmpty();
    }

    public boolean sameStatus() {
        return reference.status() == subject.status();
    }

    /** Stable reference, same status, and (for 2xx) same content class and value up to key order. */
    public boolean equivalent() {
        return referenceStable() && sameStatus() && differences.isEmpty();
    }

    private static List<JsonDiff.Diff> compare(Observation a, Observation b, UnaryOperator<JsonNode> mask) {
        List<JsonDiff.Diff> out = new ArrayList<>();
        if (a.status() != b.status()) {
            out.add(new JsonDiff.Diff("status", JsonDiff.Kind.VALUE, String.valueOf(a.status()), String.valueOf(b.status())));
            return out;
        }
        if (a.success() != b.success()) {
            out.add(new JsonDiff.Diff("$", JsonDiff.Kind.TYPE, readable(a), readable(b)));
            return out;
        }
        if (!a.success()) {
            return out;
        }
        if (a.contentClass() != b.contentClass()) {
            out.add(new JsonDiff.Diff("content-class", JsonDiff.Kind.TYPE, a.contentClass().name(), b.contentClass().name()));
            return out;
        }
        JsonDiff.diff(mask.apply(a.value()), mask.apply(b.value())).stream()
                .filter(d -> d.kind() != JsonDiff.Kind.KEY_ORDER)
                .forEach(out::add);
        return out;
    }

    private static String readable(Observation o) {
        return o.error() == null ? o.contentClass().name() : "unreadable: " + o.error();
    }
}
