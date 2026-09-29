package io.github.irelandsamantha.keycloakmcp.equivalence;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.SortedMap;
import java.util.TreeMap;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The ledger's closing check (DESIGN §1): every reference operation must end in exactly one verdict,
 * {@code EQUIVALENT}, {@code ROUTED_ONLY} or {@code DIVERGENT_DOCUMENTED}. Runs after every other IT class of the
 * run ({@code junit-platform.properties} orders classes by {@link Order}) and reads the ledger they filled.
 *
 * <p>An operation a check refused is unaccounted, and fails the run with the check and outcome that refused it.
 * An operation left to a functional check that was not selected for this run (e.g. {@code -Dit.test=...}) has no
 * verdict yet; the second test is then aborted, not passed, and names the missing checks.
 */
@ExtendWith(EquivalenceExtension.class)
@Order(Integer.MAX_VALUE)
class LedgerCompletenessIT {

    private static EquivalenceEnvironment env;
    private static Map<String, Verdict> verdicts;
    private static Map<String, EquivalenceLedger.Row> rows;

    @BeforeAll
    static void read(EquivalenceEnvironment environment) {
        env = environment;
        rows = env.ledger().rows();
        verdicts = env.ledger().verdicts();
        System.out.printf("Ledger: %d reference operations, verdicts %s, functional checks run %s%n", verdicts.size(),
                Verdict.histogram(verdicts), env.ledger().functionalChecksRun());
    }

    @AfterAll
    static void writeLedger() throws Exception {
        env.writeLedger();
    }

    @Test
    void noOperationIsUnaccounted() {
        SortedMap<String, List<String>> byCause = new TreeMap<>();
        rows.forEach((key, row) -> {
            if (verdicts.get(key).outcome() == Verdict.Outcome.UNACCOUNTED) {
                byCause.computeIfAbsent(cause(row), c -> new ArrayList<>()).add(row.key());
            }
        });
        assertTrue(byCause.isEmpty(), () -> "Unaccounted operations, by the check and outcome that refused them ("
                + byCause.values().stream().mapToInt(List::size).sum() + "):\n" + byCause.entrySet().stream()
                .map(e -> "  " + e.getKey() + " (" + e.getValue().size() + "):\n" + e.getValue().stream()
                        .map(k -> "    " + k + "\n").collect(Collectors.joining()))
                .collect(Collectors.joining()));
    }

    @Test
    void everyOperationHasAVerdict() {
        List<String> pending = verdicts.entrySet().stream().filter(e -> e.getValue().outcome() == Verdict.Outcome.PENDING)
                .map(e -> rows.get(e.getKey()).key()).toList();
        String incomplete = pending.size() + " operations have no verdict because a functional check did not run in this"
                + " execution (" + notRun() + "); run every IT for the complete proof. First: " + pending.stream().limit(5).toList();
        if (!pending.isEmpty()) {
            // Failsafe's report drops an aborted test's reason.
            System.out.println("Ledger incomplete: " + incomplete);
        }
        assumeTrue(pending.isEmpty(), incomplete);
    }

    /** The first check that refused an operation, as {@code check OUTCOME}. */
    private static String cause(EquivalenceLedger.Row row) {
        return row.checks().entrySet().stream().filter(e -> !e.getValue().accepted())
                .map(e -> e.getKey() + " " + e.getValue().outcome()).findFirst()
                .orElse("no functional check covers it");
    }

    private static List<String> notRun() {
        return Verdict.FUNCTIONAL.stream().filter(f -> !env.ledger().functionalChecksRun().contains(f)).toList();
    }
}
