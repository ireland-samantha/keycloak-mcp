package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ForcedFailureFrameTest {

    private static final String CREATE = "POST /admin/realms/{realm}/groups";
    private static final String DELETE = "DELETE /admin/realms/{realm}/groups/{group-id}";
    private static final String FAILING = "GET /admin/realms/{realm}/groups/{group-id}";

    private static final Step OPERATION = Step.of(CREATE, Json.read("""
            {"body": {"name": "delta"}}""")).compensatedBy(Step.of(DELETE, Json.read("""
            {"path": {"group-id": "$step.locationId"}}""")));
    private static final Step FORCED = Step.of(FAILING, Json.read("""
            {"path": {"group-id": "absent"}}"""));

    private static final State BEFORE = groups("""
            [{"name": "alpha"}]""");
    private static final State CHANGED = groups("""
            [{"name": "alpha"}, {"name": "delta"}]""");

    private static State groups(String value) {
        return new State(List.of(new State.Entry("GET /admin/realms/{realm}/groups", false, 200, Json.read(value))));
    }

    /** An {@code IN_DOUBT} answer with the given report members. */
    private static Result inDoubt(String failedOperation, String completed, String rollback) {
        return new Result(false, """
                {"status": "IN_DOUBT", "failedOperation": "%s", "error": "Keycloak operation failed (HTTP 404; attempts 1)",
                 "completed": %s, "rollback": %s}""".formatted(failedOperation, completed, rollback));
    }

    private static final String CREATED = """
            [{"operation": "%s", "status": 201}]""".formatted(CREATE);
    private static final String COMPENSATED = """
            [{"operation": "%s", "status": 204, "outcome": "COMPENSATED"}]""".formatted(DELETE);

    private static Check judge(Result run, State after) {
        return ForcedFailureFrame.judge(OPERATION, FORCED, run, BEFORE, after);
    }

    @Test
    void theDeclaredCompensationRestoringThePreStateIsSound() {
        Check check = judge(inDoubt(FAILING, CREATED, COMPENSATED), BEFORE);
        assertEquals(CaseOutcome.SOUND, check.outcome(), check.detail());
        assertTrue(check.accepted());
    }

    @Test
    void anOperationThatItselfFailedExercisedNothing() {
        Result conflict = new Result(false, """
                {"status": "IN_DOUBT", "failedOperation": "%s", "error": "Keycloak operation failed (HTTP 409; attempts 1)",
                 "failedStepMayHaveCommitted": true, "rollback": [], "completed": []}""".formatted(CREATE));
        Check check = judge(conflict, BEFORE);
        assertEquals(CaseOutcome.NOT_EXERCISED, check.outcome(), check.detail());
        assertTrue(check.accepted(), "accepted, but never SOUND");
    }

    /**
     * The shape of the group move keycloak-mcp takes for a create: the server moves the group and answers 204, and
     * keycloak-mcp then fails the step for want of a Location, reporting nothing completed and nothing to roll back.
     */
    @Test
    void anOperationThatFailedButChangedTheStateIsUnsound() {
        Result committed = new Result(false, """
                {"status": "IN_DOUBT", "failedOperation": "%s", "error": "create succeeded without a Location for compensation",
                 "failedStepMayHaveCommitted": true, "rollback": [], "completed": []}""".formatted(CREATE));
        assertUnsound(judge(committed, CHANGED), "yet the server committed it: the readbacks differ from the pre-state:"
                + " [GET /admin/realms/{realm}/groups:");
    }

    @Test
    void aCompletedOperationWithAnEmptyRollbackIsUnsound() {
        Check check = judge(inDoubt(FAILING, CREATED, "[]"), BEFORE);
        assertUnsound(check, "the rollback is []");
    }

    @Test
    void aFailedCompensationIsUnsound() {
        Check check = judge(inDoubt(FAILING, CREATED, """
                [{"operation": "%s", "outcome": "FAILED", "error": "HTTP 404"}]""".formatted(DELETE)), BEFORE);
        assertUnsound(check, "not the declared compensation");
    }

    @Test
    void aCompensationOtherThanTheDeclaredOneIsUnsound() {
        String twice = """
                [{"operation": "%1$s", "outcome": "COMPENSATED"}, {"operation": "%1$s", "outcome": "COMPENSATED"}]"""
                .formatted(DELETE);
        assertUnsound(judge(inDoubt(FAILING, CREATED, twice), BEFORE), "not the declared compensation");
        String other = """
                [{"operation": "PUT /admin/realms/{realm}/groups/{group-id}", "outcome": "COMPENSATED"}]""";
        assertUnsound(judge(inDoubt(FAILING, CREATED, other), BEFORE), "not the declared compensation");
    }

    @Test
    void aFailureOtherThanTheForcedOneIsUnsound() {
        String unrelated = "GET /admin/realms/{realm}/roles";
        assertUnsound(judge(inDoubt(unrelated, CREATED, COMPENSATED), BEFORE), "not on the forced failure");
    }

    @Test
    void theOperationMustHaveCompletedWithA2xx() {
        String otherStep = """
                [{"operation": "PUT /admin/realms/{realm}/groups/{group-id}", "status": 204}]""";
        assertUnsound(judge(inDoubt(FAILING, otherStep, COMPENSATED), BEFORE), "not the operation alone");
        String notModified = """
                [{"operation": "%s", "status": 304}]""".formatted(CREATE);
        assertUnsound(judge(inDoubt(FAILING, notModified, COMPENSATED), BEFORE), "not the operation alone");
    }

    @Test
    void aStateThatDiffersFromBeforeIsUnsound() {
        assertUnsound(judge(inDoubt(FAILING, CREATED, COMPENSATED), CHANGED), "the readbacks differ from the pre-state");
    }

    @Test
    void aFrameThatDidNotEndInDoubtIsUnsound() {
        Result completed = new Result(false, """
                {"status": "COMPLETED", "completed": [{"operation": "%s", "status": 201},
                 {"operation": "%s", "status": 200}]}""".formatted(CREATE, FAILING));
        assertUnsound(judge(completed, BEFORE), "did not end IN_DOUBT");
        assertUnsound(judge(new Result(true, "writes are disabled"), BEFORE), "did not end IN_DOUBT");
    }

    @Test
    void anOperationWithoutACompensationIsNeverSound() {
        Step bare = Step.of(CREATE, Json.read("""
                {"body": {"name": "delta"}}"""));
        Check check = ForcedFailureFrame.judge(bare, FORCED, inDoubt(FAILING, CREATED, "[]"), BEFORE, BEFORE);
        assertUnsound(check, "no compensation to exercise");
    }

    private static void assertUnsound(Check check, String reason) {
        assertEquals(CaseOutcome.UNSOUND, check.outcome(), check.detail());
        assertFalse(check.accepted());
        assertTrue(check.detail().contains(reason), () -> "expected '" + reason + "' in: " + check.detail());
    }
}
