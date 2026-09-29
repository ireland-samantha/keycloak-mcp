package io.github.irelandsamantha.keycloakmcp.equivalence.ledger;

import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.SortedMap;
import java.util.TreeMap;

import static io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict.F1_ADAPTER;
import static io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict.F1_READ;
import static io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict.F2_MUTATION;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VerdictTest {

    private static final Set<String> BOTH_RAN = Set.of(F1_READ, F2_MUTATION);

    @Test
    void functionalEquivalenceWithPassingStructuralChecksIsEquivalent() {
        Verdict v = Verdict.of(checks("S3:routed", "ROUTED", true, F1_READ, "EQUIVALENT", true), BOTH_RAN);
        assertEquals(Verdict.Outcome.EQUIVALENT, v.outcome());
        assertTrue(v.accounted());
    }

    @Test
    void anyUnacceptedCheckMakesTheOperationUnaccounted() {
        Verdict v = Verdict.of(checks("S1:listed", "MISSING", false, F1_READ, "EQUIVALENT", true), BOTH_RAN);
        assertEquals(Verdict.Outcome.UNACCOUNTED, v.outcome());
        assertTrue(v.detail().contains("S1:listed MISSING"), v.detail());
    }

    @Test
    void aDocumentedDivergenceAnywhereOutranksEquivalence() {
        Verdict v = Verdict.of(checks(F1_READ, "EQUIVALENT", true, F1_ADAPTER, "DIVERGENT_DOCUMENTED", true), BOTH_RAN);
        assertEquals(Verdict.Outcome.DIVERGENT_DOCUMENTED, v.outcome());
        assertTrue(v.detail().startsWith(F1_ADAPTER), v.detail());
    }

    @Test
    void routedOnlyCarriesTheFunctionalReason() {
        Verdict v = Verdict.of(checks(F1_READ, "ROUTED_ONLY", true, "S3:routed", "ROUTED", true), BOTH_RAN);
        assertEquals(Verdict.Outcome.ROUTED_ONLY, v.outcome());
        assertTrue(v.detail().startsWith(F1_READ + " ROUTED_ONLY"), v.detail());
    }

    @Test
    void anOperationLeftToACheckThatDidNotRunIsPending() {
        Verdict v = Verdict.of(checks(F1_READ, Verdict.OUT_OF_SCOPE, true, "S3:routed", "ROUTED", true), Set.of(F1_READ));
        assertEquals(Verdict.Outcome.PENDING, v.outcome());
        assertTrue(v.detail().contains(F2_MUTATION), v.detail());
    }

    @Test
    void anOperationACheckLeftOutIsPendingWithTheReason() {
        Verdict v = Verdict.of(checks(F1_READ, Verdict.OUT_OF_SCOPE, true, F2_MUTATION, Verdict.NOT_SELECTED, true), BOTH_RAN);
        assertEquals(Verdict.Outcome.PENDING, v.outcome());
        assertTrue(v.detail().contains(F2_MUTATION + " " + Verdict.NOT_SELECTED), v.detail());
    }

    @Test
    void anOperationNoFunctionalCheckCoversIsUnaccountedOnceAllRan() {
        SortedMap<String, EquivalenceLedger.Check> c = checks(F1_READ, Verdict.OUT_OF_SCOPE, true, F2_MUTATION, Verdict.OUT_OF_SCOPE, true);
        assertEquals(Verdict.Outcome.UNACCOUNTED, Verdict.of(c, BOTH_RAN).outcome());
    }

    @Test
    void aStructuralCheckAloneIsNoVerdict() {
        Verdict v = Verdict.of(checks("S3:routed", "ROUTED", true, "S1:listed", "LISTED", true), Set.of());
        assertEquals(Verdict.Outcome.PENDING, v.outcome());
    }

    private static SortedMap<String, EquivalenceLedger.Check> checks(Object... nameOutcomeAccepted) {
        SortedMap<String, EquivalenceLedger.Check> out = new TreeMap<>();
        for (int i = 0; i < nameOutcomeAccepted.length; i += 3) {
            out.put((String) nameOutcomeAccepted[i], new EquivalenceLedger.Check((String) nameOutcomeAccepted[i + 1],
                    (Boolean) nameOutcomeAccepted[i + 2], "d" + i));
        }
        return out;
    }
}
