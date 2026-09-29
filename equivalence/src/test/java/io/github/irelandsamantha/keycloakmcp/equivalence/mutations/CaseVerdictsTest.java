package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CaseVerdictsTest {

    private static CaseOutcome outcome(String name, Check compensation, Check equivalence) {
        MutationCase c = MutationCase.of("PUT /admin/realms/{realm}/roles/{role-name}", name)
                .args(r -> CaseArgs.path(r.realm(), "writer"))
                .readback(Readback.of("GET /admin/realms/{realm}/roles", r -> CaseArgs.path(r.realm())))
                .irreversible("test")
                .build();
        return new CaseOutcome(c, compensation, equivalence);
    }

    private static Check ok(String outcome) {
        return new Check(outcome, true, "fine");
    }

    @Test
    void acceptedCasesThatShowEquivalenceMakeTheOperationEquivalent() {
        List<CaseOutcome> cases = List.of(outcome("update", ok(CaseOutcome.SOUND), ok(CaseOutcome.EQUIVALENT)),
                outcome("refused", ok(CaseOutcome.IRREVERSIBLE), ok(CaseOutcome.REFUSED)));
        assertEquals(new Check(CaseOutcome.EQUIVALENT, true, "update: EQUIVALENT (fine); refused: REFUSED (fine)"),
                CaseVerdicts.mutation(cases));
        assertEquals(CaseOutcome.SOUND, CaseVerdicts.compensation(cases).outcome());
    }

    @Test
    void anOperationKeycloakMcpRefusesAsExpectedIsRoutedOnly() {
        Check verdict = CaseVerdicts.mutation(List.of(outcome("rename", ok(CaseOutcome.IRREVERSIBLE), ok(CaseOutcome.REFUSED))));
        assertEquals("ROUTED_ONLY", verdict.outcome());
        assertTrue(verdict.accepted());
    }

    @Test
    void oneFailingCaseLeavesTheOperationUnaccounted() {
        List<CaseOutcome> cases = List.of(outcome("update", ok(CaseOutcome.SOUND), ok(CaseOutcome.EQUIVALENT)),
                outcome("rename", new Check(CaseOutcome.MISCLASSIFIED, false, "counterexample"), ok(CaseOutcome.EQUIVALENT)));
        Check compensation = CaseVerdicts.compensation(cases);
        assertEquals(new Check(CaseOutcome.MISCLASSIFIED, false, "rename: MISCLASSIFIED (counterexample)"), compensation);
        assertTrue(CaseVerdicts.mutation(cases).accepted(), "F2 and F3 are judged separately");
        assertFalse(outcome("x", compensation, ok(CaseOutcome.EQUIVALENT)).accepted());
    }
}
