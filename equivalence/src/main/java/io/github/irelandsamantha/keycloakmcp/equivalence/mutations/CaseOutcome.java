package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;

/**
 * What one case showed.
 *
 * @param compensation F3: how keycloak-mcp classifies the undo, and whether a compensation it accepts restores the
 *                     state after a forced failure
 * @param equivalence  F2: whether keycloak-mcp and the reference answered alike and left the twins in the same state
 */
public record CaseOutcome(MutationCase mutationCase, Check compensation, Check equivalence) {

    /** F3: keycloak-mcp accepted the compensation, and it restored the pre-state. */
    public static final String SOUND = "SOUND";
    /**
     * F3: keycloak-mcp accepted the compensation, but the forced-failure frame did not show it restoring the
     * pre-state: the operation, the failed step, the rollback or the state after it was not what soundness requires,
     * or the server committed an operation keycloak-mcp reports as failed, with nothing compensated.
     */
    public static final String UNSOUND = "UNSOUND";
    /**
     * F3: keycloak-mcp accepted the compensation, but the operation itself failed in the frame and left the state as
     * it was, so no compensation ran. Accepted, and proves nothing: an operation needs a {@link #SOUND} case to be
     * sound. An operation that failed in keycloak-mcp but changed the state is {@link #UNSOUND}.
     */
    public static final String NOT_EXERCISED = "NOT_EXERCISED";
    /** F3: keycloak-mcp accepts as reversible what the case shows cannot be undone. */
    public static final String MISCLASSIFIED = "MISCLASSIFIED";
    /** F3: keycloak-mcp refuses it without the irreversible override, as expected. */
    public static final String IRREVERSIBLE = "IRREVERSIBLE";
    /** F3: reversible, but keycloak-mcp accepts no compensation for it; safe, so accepted. */
    public static final String NOT_COMPENSABLE = "NOT_COMPENSABLE";

    /** F2: both sides performed the mutation (2xx) and left the twins in the same state. */
    public static final String EQUIVALENT = "EQUIVALENT";
    /**
     * F2: both sides rejected the request in the same non-2xx status class and left the twins in the same state.
     * Accepted, but the mutation was never performed: an operation needs an {@link #EQUIVALENT} case to be equivalent.
     */
    public static final String REJECTED_ALIKE = "REJECTED_ALIKE";
    public static final String DIVERGENT = "DIVERGENT";
    /** F2: keycloak-mcp refuses to perform it at all. */
    public static final String REFUSED = "REFUSED";
    public static final String CATALOG_MISSING = "CATALOG_MISSING";
    public static final String ERROR = "ERROR";

    public boolean accepted() {
        return compensation.accepted() && equivalence.accepted();
    }

    static CaseOutcome failed(MutationCase mutationCase, String outcome, String detail) {
        Check check = new Check(outcome, false, detail);
        return new CaseOutcome(mutationCase, check, check);
    }

    @Override
    public String toString() {
        return mutationCase.displayName() + "\n  F3 " + compensation.outcome() + ": " + compensation.detail()
                + "\n  F2 " + equivalence.outcome() + ": " + equivalence.detail();
    }
}
