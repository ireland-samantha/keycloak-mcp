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
     * F2: {@code EQUIVALENT} when every case is accepted and in one both sides performed the mutation;
     * {@code ROUTED_ONLY} when none performed it (keycloak-mcp, as expected, refused it, or both sides rejected it
     * alike); otherwise the first failing case's outcome, not accepted.
     */
    public static Check mutation(List<CaseOutcome> outcomes) {
        return combine(outcomes, CaseOutcome::equivalence, CaseOutcome.EQUIVALENT, Verdict.Outcome.ROUTED_ONLY.name());
    }

    /**
     * F3: {@code SOUND} when every case is accepted and a frame exercised the compensation and restored the state;
     * {@code NOT_EXERCISED} when keycloak-mcp accepts a compensation no frame exercised; otherwise the first case's
     * outcome (e.g. {@code IRREVERSIBLE}), or the first failing case's outcome, not accepted.
     */
    public static Check compensation(List<CaseOutcome> outcomes) {
        boolean unexercised = outcomes.stream().anyMatch(o -> o.compensation().outcome().equals(CaseOutcome.NOT_EXERCISED));
        return combine(outcomes, CaseOutcome::compensation, CaseOutcome.SOUND, unexercised ? CaseOutcome.NOT_EXERCISED
                : outcomes.isEmpty() ? null : outcomes.getFirst().compensation().outcome());
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
