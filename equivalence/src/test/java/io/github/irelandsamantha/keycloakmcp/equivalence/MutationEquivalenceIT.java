package io.github.irelandsamantha.keycloakmcp.equivalence;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpPair;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads.Classification;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.CaseArgs;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.CaseOutcome;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.CaseVerdicts;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.MutationCase;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.MutationCoverage;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.MutationFamilies;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.MutationFamily;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.MutationRunner;
import io.github.irelandsamantha.keycloakmcp.equivalence.oracle.AdminClientOracle;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.OpView;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.ReferenceSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.extension.ExtendWith;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

/**
 * F2 mutation equivalence and F3 compensation soundness (DESIGN §1), one dynamic test per {@link MutationCase} of
 * every {@link MutationFamily}; {@link MutationRunner} says what a case proves. Cases that need fixes keycloak-mcp
 * does not have yet run under the {@value RequiresNodeFixes#TAG} tag and fail until the fixes land.
 *
 * <p>F2 owns the reference operations keycloak-mcp classifies as mutations (its dry run refuses them with writes
 * off), and the non-GET operations its catalog lacks. Each one gets an {@code F2:mutation} verdict: its cases' result,
 * or {@code ROUTED_ONLY} ("no mutation case") until a family covers it; {@code target/mutation-coverage.json} lists
 * those. Every other reference operation is out of F2's scope.
 *
 * <p>{@code -Dequivalence.families=a,b} runs only the named families. An operation some other family covers is then
 * {@value Verdict#NOT_SELECTED}, and has no verdict in this run.
 */
@ExtendWith(EquivalenceExtension.class)
class MutationEquivalenceIT {

    private static final Path COVERAGE = Path.of("target", "mutation-coverage.json");

    /** Realm keycloak-mcp is pinned to while it only classifies; a dry run sends nothing. */
    private static final String CLASSIFYING_REALM = "equivalence-f2-classify";

    /** Any path value lets a dry run pass argument checks; a mutation is refused whatever the arguments. */
    private static final String ANY_VALUE = "equivalence-classify";

    private enum Scope { MUTATION, READ, UNKNOWN }

    /** Whether F2 owns an operation, and why. */
    private record Owner(Scope scope, String reason) {
    }

    private static EquivalenceEnvironment env;
    private static ReferenceSurface reference;
    private static Map<String, Owner> owners;
    private static MutationCoverage coverage;
    private static List<MutationFamily> selected;
    private static AdminClientOracle adapter;
    private static MutationRunner runner;
    private static final Map<String, List<CaseOutcome>> outcomes = new ConcurrentHashMap<>();

    @BeforeAll
    static void start(EquivalenceEnvironment environment) throws Exception {
        env = environment;
        reference = env.reference();
        Map<String, JsonNode> catalog = env.catalog().operations().stream().collect(Collectors.toMap(
                op -> PathTemplates.operationKey(op.path("method").asText(), op.path("path").asText()), op -> op, (a, b) -> a));
        owners = classify(catalog);
        Map<String, String> mutations = new TreeMap<>();
        owners.forEach((key, owner) -> {
            if (owner.scope() == Scope.MUTATION) {
                OpView op = reference.primary(key);
                mutations.put(key, op.method() + " " + op.path());
            }
        });
        coverage = MutationCoverage.of(env.catalog().version(), mutations, MutationFamilies.all());
        selected = MutationFamilies.select(env.settings().families());
        Map<String, List<Endpoint>> bindings = env.adminClientSurface().endpoints().stream()
                .collect(Collectors.groupingBy(Endpoint::key));
        adapter = new AdminClientOracle(env.serverUrl(), env.serviceAccount());
        runner = new MutationRunner(env, catalog, bindings, adapter);
        System.out.printf("F2: %d of %d mutation operations have cases; %d are ROUTED_ONLY ('no mutation case'), listed in %s%n",
                coverage.covered(), coverage.mutationOperations(), coverage.uncovered().size(), COVERAGE);
        if (!env.settings().families().isEmpty()) {
            System.out.printf("F2: running the families %s only (equivalence.families)%n",
                    selected.stream().map(MutationFamily::name).toList());
        }
    }

    @AfterAll
    static void stop() throws Exception {
        try {
            if (owners != null) {
                record();
                Json.write(COVERAGE, coverage);
            }
        } finally {
            if (adapter != null) {
                adapter.close();
            }
            env.writeLedger();
        }
    }

    @TestFactory
    Stream<DynamicTest> everyCaseMatchesTheReference() {
        return Stream.concat(Stream.of(dynamicTest("every case exercises a mutation", MutationEquivalenceIT::casesAreMutations)),
                tests(c -> c.requires().isEmpty()));
    }

    @TestFactory
    @Tag(RequiresNodeFixes.TAG)
    Stream<DynamicTest> casesAwaitingNodeFixes() {
        return tests(c -> !c.requires().isEmpty());
    }

    private static Stream<DynamicTest> tests(Predicate<MutationCase> which) {
        return selected.stream().flatMap(family -> family.cases().stream().filter(which)
                .map(c -> dynamicTest(c.displayName(), () -> check(family, c))));
    }

    private static void check(MutationFamily family, MutationCase mutation) {
        CaseOutcome outcome = runner.run(family, mutation);
        outcomes.computeIfAbsent(mutation.operationKey(), k -> Collections.synchronizedList(new ArrayList<>())).add(outcome);
        // The case leads the message: Failsafe reports dynamic tests by index, not by display name.
        assertTrue(outcome.accepted(), outcome::toString);
    }

    private static void casesAreMutations() {
        assertTrue(coverage.notMutations().isEmpty(), () -> "Cases for operations F2 does not own (keycloak-mcp"
                + " classifies them as reads, so F1 covers them): " + coverage.notMutations());
    }

    /**
     * Which reference operations F2 owns, by keycloak-mcp's own classification, observed without sending anything;
     * an operation without {@code {realm}} is classified with realm administration on ({@link KeycloakMcpPair}).
     */
    private static Map<String, Owner> classify(Map<String, JsonNode> catalog) throws Exception {
        try (KeycloakMcpPair mcp = KeycloakMcpPair.start(env, CLASSIFYING_REALM, Map.of())) {
            KeycloakMcpReads.brokenSignals(mcp.pinned()).ifPresent(answers -> fail("keycloak-mcp's dry run no longer"
                    + " tells a mutation from a read the way KeycloakMcpReads expects, so F2 cannot tell what it owns. " + answers));
            Map<String, Owner> out = new TreeMap<>();
            for (String key : reference.keys()) {
                out.put(key, owner(mcp, reference.primary(key), catalog.get(key)));
            }
            return out;
        }
    }

    private static Owner owner(KeycloakMcpPair mcp, OpView op, JsonNode listed) throws Exception {
        if (listed == null) {
            return op.method().equals("GET") || op.method().equals("HEAD")
                    ? new Owner(Scope.READ, "a " + op.method() + " absent from the catalog; F1 covers it")
                    : new Owner(Scope.MUTATION, "absent from catalog '" + env.catalog().version() + "'");
        }
        String template = listed.path("path").asText();
        CaseArgs args = new CaseArgs(Collections.nCopies(PathTemplates.variableNames(template).size(), ANY_VALUE), Map.of(), null);
        Classification classification = mcp.classify(listed.path("key").asText(), template, args.mcpArguments(template));
        return switch (classification.kind()) {
            case MUTATION -> new Owner(Scope.MUTATION, "keycloak-mcp classifies it as a mutation");
            case READ -> new Owner(Scope.READ, "keycloak-mcp classifies it as a read; F1 covers it");
            case UNKNOWN, REALM_ADMINISTRATION_DISABLED -> new Owner(Scope.UNKNOWN, "keycloak-mcp's dry run neither accepted it as a read nor refused"
                    + " it as a mutation: " + classification.answer());
        };
    }

    private static void record() {
        Map<String, List<MutationCase>> cases = MutationFamilies.all().stream().flatMap(f -> f.cases().stream())
                .collect(Collectors.groupingBy(MutationCase::operationKey));
        List<String> ran = selected.stream().map(MutationFamily::name).toList();
        Map<String, List<String>> deselected = new TreeMap<>();
        MutationFamilies.all().stream().filter(f -> !ran.contains(f.name())).forEach(f -> f.cases().forEach(
                c -> deselected.computeIfAbsent(c.operationKey(), k -> new ArrayList<>()).add(f.name())));
        owners.forEach((key, owner) -> {
            switch (owner.scope()) {
                case READ -> env.ledger().record(key, Verdict.F2_MUTATION, Verdict.OUT_OF_SCOPE, true, owner.reason());
                case UNKNOWN -> env.ledger().record(key, Verdict.F2_MUTATION, "CLASSIFICATION_UNKNOWN", false, owner.reason());
                case MUTATION -> {
                    if (deselected.containsKey(key)) {
                        // A verdict from part of an operation's cases would claim what the others may refute.
                        env.ledger().record(key, Verdict.F2_MUTATION, Verdict.NOT_SELECTED, true, "cases of the families "
                                + deselected.get(key).stream().distinct().toList() + " did not run (equivalence.families)");
                    } else {
                        recordMutation(key, cases.getOrDefault(key, List.of()));
                    }
                }
            }
        });
    }

    /** The operation's verdict from all of its cases; a case that did not run leaves it unproven. */
    private static void recordMutation(String key, List<MutationCase> cases) {
        if (cases.isEmpty()) {
            env.ledger().record(key, Verdict.F2_MUTATION, Verdict.Outcome.ROUTED_ONLY.name(), true, "no mutation case");
            return;
        }
        List<CaseOutcome> ran = outcomes.getOrDefault(key, List.of());
        if (ran.size() < cases.size()) {
            env.ledger().record(key, Verdict.F2_MUTATION, "INCOMPLETE", false, (cases.size() - ran.size()) + " of its "
                    + cases.size() + " cases did not run in this execution");
            return;
        }
        Check mutation = CaseVerdicts.mutation(ran);
        Check compensation = CaseVerdicts.compensation(ran);
        env.ledger().record(key, Verdict.F2_MUTATION, mutation.outcome(), mutation.accepted(), mutation.detail());
        env.ledger().record(key, Verdict.F3_COMPENSATION, compensation.outcome(), compensation.accepted(), compensation.detail());
    }
}
