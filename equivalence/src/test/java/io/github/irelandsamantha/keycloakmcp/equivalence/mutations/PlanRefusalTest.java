package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlanRefusalTest {

    private static final String UPDATE = "PUT /admin/realms/{realm}/groups/{group-id}";

    /** keycloak-mcp's refusals as its preflight words them; the judgement must not depend on the wording. */
    private static final Result OVERRIDE_REQUIRED = new Result(true, "step 1 is irreversible and requires an explicit override");
    private static final Result COMPENSATION_REQUIRED = new Result(true, "step 1 needs an explicit compensation");
    private static final Result COMPENSATION_REFUSED = new Result(true, "step 1 update compensation must target the same resource");
    private static final Result PLANNED = new Result(false, """
            {"status": "PREFLIGHT_OK", "steps": [{"operation": "%s", "compensation": "%s"}]}""".formatted(UPDATE, UPDATE));

    private static MutationCase.Builder update(String name) {
        return MutationCase.of(UPDATE, name)
                .args(r -> CaseArgs.path(r.realm(), "group"))
                .readback(Readback.of("GET " + UPDATE, r -> CaseArgs.path(r.realm(), "group")));
    }

    private static MutationCase.Builder undone(String name) {
        return update(name).compensatedBy(r -> new CaseRequest(UPDATE, CaseArgs.path(r.realm(), "group")));
    }

    @Test
    void aCaseWithoutACompensationNeverShowsTheOperationIrreversible() {
        MutationCase bare = update("bare").irreversible("test").build();
        for (Result refusal : new Result[] {COMPENSATION_REQUIRED, OVERRIDE_REQUIRED}) {
            Check check = PlanRefusal.judge(bare, refusal, null);
            assertEquals(CaseOutcome.AMBIGUOUS_REFUSAL, check.outcome(), check.detail());
            assertTrue(check.accepted(), "accepted, but never IRREVERSIBLE");
            assertTrue(check.detail().contains("the case offers no compensation"), check::detail);
        }
    }

    @Test
    void aRefusalTheOverrideLiftsShowsTheOperationIrreversible() {
        Check check = PlanRefusal.judge(undone("undone").irreversible("test").build(), OVERRIDE_REQUIRED, PLANNED);
        assertEquals(CaseOutcome.IRREVERSIBLE, check.outcome(), check.detail());
        assertTrue(check.accepted());
    }

    @Test
    void aCompensationRefusedWithTheOverrideTooShowsNothing() {
        Check check = PlanRefusal.judge(undone("undone").irreversible("test").build(), COMPENSATION_REFUSED,
                COMPENSATION_REFUSED);
        assertEquals(CaseOutcome.AMBIGUOUS_REFUSAL, check.outcome(), check.detail());
        assertTrue(check.accepted());
        assertTrue(check.detail().contains("refuses the offered compensation with the override too"), check::detail);
    }

    @Test
    void aReversibleCaseKeycloakMcpRefusesIsNotCompensable() {
        MutationCase reversible = undone("undone").reversible("test").build();
        for (Result overridden : new Result[] {PLANNED, COMPENSATION_REFUSED}) {
            Check check = PlanRefusal.judge(reversible, OVERRIDE_REQUIRED, overridden);
            assertEquals(CaseOutcome.NOT_COMPENSABLE, check.outcome(), check.detail());
            assertTrue(check.accepted());
        }
    }

    @Test
    void anAnswerThatIsNeitherPlanNorRefusalIsAnError() {
        MutationCase irreversible = undone("undone").irreversible("test").build();
        Result completed = new Result(false, """
                {"status": "COMPLETED", "completed": []}""");
        assertError(PlanRefusal.judge(irreversible, completed, PLANNED), "neither accepted nor refused it");
        assertError(PlanRefusal.judge(irreversible, OVERRIDE_REQUIRED, completed), "with the override neither");
    }

    private static void assertError(Check check, String reason) {
        assertEquals(CaseOutcome.ERROR, check.outcome(), check.detail());
        assertFalse(check.accepted());
        assertTrue(check.detail().contains(reason), () -> "expected '" + reason + "' in: " + check.detail());
    }
}
