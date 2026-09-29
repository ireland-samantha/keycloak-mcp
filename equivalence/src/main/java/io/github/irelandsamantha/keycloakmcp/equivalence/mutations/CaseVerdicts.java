package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict;

import java.util.List;
import java.util.function.Function;
import java.util.stream.Collectors;

/** What the cases of one operation add up to, as the ledger's F2 and F3 checks. */
public final class CaseVerdicts {

    private CaseVerdicts() {
    }

    /**
     * F2: {@code EQUIVALENT} when every case is accepted and one showed equivalence; {@code ROUTED_ONLY} when
     * keycloak-mcp, as expected, refuses every case; otherwise the first failing case's outcome, not accepted.
     */
    public static Check mutation(List<CaseOutcome> outcomes) {
        return combine(outcomes, CaseOutcome::equivalence, CaseOutcome.EQUIVALENT, Verdict.Outcome.ROUTED_ONLY.name());
    }

    /** F3: {@code SOUND} when a frame restored the state and no case failed; else the first failing case's outcome. */
    public static Check compensation(List<CaseOutcome> outcomes) {
        return combine(outcomes, CaseOutcome::compensation, CaseOutcome.SOUND,
                outcomes.isEmpty() ? null : outcomes.getFirst().compensation().outcome());
    }

    private static Check combine(List<CaseOutcome> outcomes, Function<CaseOutcome, Check> check, String proven,
                                 String otherwise) {
        if (outcomes.isEmpty()) {
            throw new IllegalArgumentException("No cases to combine");
        }
        List<CaseOutcome> failing = outcomes.stream().filter(o -> !check.apply(o).accepted()).toList();
        List<CaseOutcome> reported = failing.isEmpty() ? outcomes : failing;
        String detail = reported.stream().map(o -> o.mutationCase().name() + ": " + check.apply(o).outcome() + " ("
                + check.apply(o).detail() + ")").collect(Collectors.joining("; "));
        if (!failing.isEmpty()) {
            return new Check(check.apply(failing.getFirst()).outcome(), false, detail);
        }
        boolean shown = outcomes.stream().anyMatch(o -> check.apply(o).outcome().equals(proven));
        return new Check(shown ? proven : otherwise, true, detail);
    }
}
