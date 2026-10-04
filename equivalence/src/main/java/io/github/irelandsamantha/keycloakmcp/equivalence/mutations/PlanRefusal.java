package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;

import java.util.Objects;

/**
 * F3's reading of keycloak-mcp's refusal to plan a case's operation, with the case's compensation, without the
 * irreversible override. keycloak-mcp refuses every mutation step that has no compensation and no override, and it
 * refuses some compensations whether or not the step is overridden. So a refusal on its own does not show that
 * keycloak-mcp classifies the operation irreversible. It shows that only when the case offers a compensation and
 * keycloak-mcp accepts the same plan once the step carries the override: the override is then the only difference
 * between the two plans.
 */
final class PlanRefusal {

    private PlanRefusal() {
    }

    /**
     * @param plan       keycloak-mcp's dry run of the operation with the case's compensation, without the override
     * @param overridden the same dry run with the override; {@code null} when the case offers no compensation
     */
    static Check judge(MutationCase mutation, Result plan, Result overridden) {
        if (!plan.refused()) {
            return new Check(CaseOutcome.ERROR, false, "keycloak-mcp's dry run neither accepted nor refused it: " + plan.text());
        }
        String refusal = "keycloak-mcp refuses it without the override (" + plan.text() + ")";
        if (mutation.compensation() == null) {
            return unattributed(mutation, refusal + ", but the case offers no compensation, and keycloak-mcp refuses"
                    + " every mutation without one");
        }
        Objects.requireNonNull(overridden, () -> mutation.displayName() + ": no dry run with the override");
        if (KeycloakMcpWorkflow.PREFLIGHT_OK.equals(overridden.status())) {
            String classified = refusal + " and accepts the same plan with it, so it classifies the operation irreversible";
            return mutation.expectedIrreversible()
                    ? new Check(CaseOutcome.IRREVERSIBLE, true, classified)
                    : new Check(CaseOutcome.NOT_COMPENSABLE, true, classified + "; F2 runs it with the override");
        }
        if (!overridden.refused()) {
            return new Check(CaseOutcome.ERROR, false, "keycloak-mcp's dry run with the override neither accepted nor"
                    + " refused it: " + overridden.text());
        }
        return unattributed(mutation, refusal + ", but it refuses the offered compensation with the override too ("
                + overridden.text() + ")");
    }

    /** A refusal the override does not attribute to keycloak-mcp's classification. */
    private static Check unattributed(MutationCase mutation, String why) {
        return mutation.expectedIrreversible()
                ? new Check(CaseOutcome.AMBIGUOUS_REFUSAL, true, why + ", so the refusal does not show that it"
                + " classifies the operation irreversible")
                : new Check(CaseOutcome.NOT_COMPENSABLE, true, why + "; F2 runs it with the override");
    }
}
