package io.github.irelandsamantha.keycloakmcp.equivalence.ledger;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.function.Predicate;
import java.util.stream.Collectors;

/**
 * The single outcome a reference operation ends in, derived from the checks recorded for it.
 *
 * <p>Functional checks ({@link #FUNCTIONAL}) give an operation its verdict: {@link Outcome#EQUIVALENT},
 * {@link Outcome#ROUTED_ONLY} (could not be exercised; the check's detail says why) or
 * {@link Outcome#DIVERGENT_DOCUMENTED} (the detail names the documented entries). A functional check that leaves an
 * operation to another one records {@link #OUT_OF_SCOPE}. Any check, structural or functional, makes an operation
 * unaccounted by recording an outcome it does not accept.
 */
public record Verdict(Outcome outcome, String detail) {

    public enum Outcome {
        EQUIVALENT, ROUTED_ONLY, DIVERGENT_DOCUMENTED,
        /** No verdict yet: a functional check that could give one did not run. */
        PENDING,
        /** A check failed, or every functional check ran and none covers the operation. */
        UNACCOUNTED
    }

    public static final String F1_READ = "F1:read";
    public static final String F1_ADAPTER = "F1:adapter";
    public static final String F2_MUTATION = "F2:mutation";
    /** Soundness of keycloak-mcp's compensation for an operation F2 exercises; not a verdict of its own. */
    public static final String F3_COMPENSATION = "F3:compensation";

    /** Checks whose outcome is a verdict; between them they must cover every reference operation. */
    public static final List<String> FUNCTIONAL = List.of(F1_READ, F2_MUTATION);

    /** Outcome of a functional check for an operation that another functional check covers. */
    public static final String OUT_OF_SCOPE = "OUT_OF_SCOPE";

    private static final Set<String> VERDICTS = Set.of(Outcome.EQUIVALENT.name(), Outcome.ROUTED_ONLY.name(),
            Outcome.DIVERGENT_DOCUMENTED.name());

    /**
     * @param checks        everything recorded for one operation, by check name
     * @param functionalRun functional checks that recorded anything in this run, for any operation
     */
    public static Verdict of(SortedMap<String, EquivalenceLedger.Check> checks, Set<String> functionalRun) {
        List<String> failed = select(checks, name -> true, c -> !c.accepted());
        if (!failed.isEmpty()) {
            return new Verdict(Outcome.UNACCOUNTED, String.join("; ", failed));
        }
        List<String> verdicts = select(checks, FUNCTIONAL::contains, c -> VERDICTS.contains(c.outcome()));
        if (verdicts.isEmpty()) {
            List<String> notRun = FUNCTIONAL.stream().filter(f -> !functionalRun.contains(f)).toList();
            return notRun.isEmpty()
                    ? new Verdict(Outcome.UNACCOUNTED, "no functional check covers it; recorded: " + select(checks, n -> true, c -> true))
                    : new Verdict(Outcome.PENDING, "no verdict from the checks that ran; did not run: " + notRun);
        }
        List<String> documented = select(checks, name -> true, c -> c.outcome().equals(Outcome.DIVERGENT_DOCUMENTED.name()));
        if (!documented.isEmpty()) {
            return new Verdict(Outcome.DIVERGENT_DOCUMENTED, String.join("; ", documented));
        }
        List<String> routedOnly = select(checks, FUNCTIONAL::contains, c -> c.outcome().equals(Outcome.ROUTED_ONLY.name()));
        return routedOnly.isEmpty() ? new Verdict(Outcome.EQUIVALENT, String.join("; ", verdicts))
                : new Verdict(Outcome.ROUTED_ONLY, String.join("; ", routedOnly));
    }

    /** Number of operations per outcome. */
    public static Map<Outcome, Long> histogram(Map<String, Verdict> verdicts) {
        return verdicts.values().stream().collect(Collectors.groupingBy(Verdict::outcome,
                () -> new EnumMap<>(Outcome.class), Collectors.counting()));
    }

    public boolean accounted() {
        return outcome == Outcome.EQUIVALENT || outcome == Outcome.ROUTED_ONLY || outcome == Outcome.DIVERGENT_DOCUMENTED;
    }

    private static List<String> select(SortedMap<String, EquivalenceLedger.Check> checks, Predicate<String> names,
                                       Predicate<EquivalenceLedger.Check> keep) {
        List<String> out = new ArrayList<>();
        checks.forEach((name, c) -> {
            if (names.test(name) && keep.test(c)) {
                out.add(name + " " + c.outcome() + (c.detail() == null ? "" : " (" + c.detail() + ")"));
            }
        });
        return out;
    }

    @Override
    public String toString() {
        return outcome + (detail == null || detail.isEmpty() ? "" : ": " + detail);
    }
}
