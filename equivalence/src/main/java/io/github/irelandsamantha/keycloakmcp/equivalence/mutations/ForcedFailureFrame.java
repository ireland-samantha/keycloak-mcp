package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Compensation;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.StepRun;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;

import java.util.ArrayList;
import java.util.List;

/**
 * F3's judgement of one forced-failure frame: keycloak-mcp ran the case's operation, with its compensation, and then
 * a step that always fails. The frame proves the compensation sound only when it exercised it: the operation
 * completed with a 2xx, the forced step is the one that failed, exactly the declared compensation ran and succeeded,
 * and the readbacks equal the pre-state. A frame whose operation itself failed exercised nothing; it is accepted, as
 * {@link CaseOutcome#NOT_EXERCISED}, but proves nothing.
 */
final class ForcedFailureFrame {

    private ForcedFailureFrame() {
    }

    /**
     * @param operation the case's operation as keycloak-mcp ran it, with its compensation
     * @param failing   the step that always fails, run after it
     * @param run       keycloak-mcp's answer to the two-step run
     * @param before    the readbacks before the run
     * @param after     the same readbacks after it
     */
    static Check judge(Step operation, Step failing, Result run, State before, State after) {
        if (!KeycloakMcpWorkflow.IN_DOUBT.equals(run.status())) {
            return new Check(CaseOutcome.UNSOUND, false, "the frame did not end IN_DOUBT: " + run.text());
        }
        List<StepRun> completed = run.completed();
        if (completed.isEmpty() && operation.operation().equals(run.failedOperation()) && run.rollback().isEmpty()) {
            return new Check(CaseOutcome.NOT_EXERCISED, true, "the operation itself failed ("
                    + run.report().path("error").asText() + "), so no compensation ran: " + run.text());
        }
        List<String> problems = new ArrayList<>();
        if (!(completed.size() == 1 && completed.getFirst().operation().equals(operation.operation())
                && completed.getFirst().status() / 100 == 2)) {
            problems.add("the completed steps are " + completed + ", not the operation alone with a 2xx status");
        }
        if (!failing.operation().equals(run.failedOperation())) {
            problems.add("the run failed on " + run.failedOperation() + ", not on the forced failure " + failing.operation());
        }
        if (operation.compensation() == null) {
            problems.add("the operation carries no compensation to exercise");
        } else if (!List.of(new Compensation(operation.compensation().operation(), KeycloakMcpWorkflow.COMPENSATED))
                .equals(run.rollback())) {
            problems.add("the rollback is " + run.rollback() + ", not the declared compensation "
                    + operation.compensation().operation() + " " + KeycloakMcpWorkflow.COMPENSATED);
        }
        List<String> changed = before.differences(after);
        if (!changed.isEmpty()) {
            problems.add("the readbacks differ from the pre-state: " + changed);
        }
        return problems.isEmpty()
                ? new Check(CaseOutcome.SOUND, true, "keycloak-mcp compensated, and the readbacks equal the pre-state: "
                + run.text())
                : new Check(CaseOutcome.UNSOUND, false, String.join("; ", problems) + ". keycloak-mcp answered " + run.text());
    }
}
