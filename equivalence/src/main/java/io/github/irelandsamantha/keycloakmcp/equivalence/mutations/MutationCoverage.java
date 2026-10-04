package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.compare.DocumentedDivergences;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Which mutation operations of the reference surface the families exercise. An operation without a case is only
 * proven routed (S3), and the ledger records it as {@code ROUTED_ONLY}: with the reason of its
 * {@value DocumentedDivergences#MUTATION_GATE} entry when the environment cannot exercise it, else as "no mutation
 * case" until a family covers it.
 *
 * @param catalogVersion     keycloak-mcp catalog the mutation set was classified with
 * @param mutationOperations how many reference operations F2 owns
 * @param covered            how many of them some case exercises
 * @param families           family name to the operations its cases exercise
 * @param gated              F2 operations no case exercises that a mutation gate documents, to its reason and entry
 * @param uncovered          F2 operations neither a case nor a gate accounts for, named as the reference names them
 * @param notMutations       case operations F2 does not own (keycloak-mcp classifies them as reads): a family error
 * @param gatesExercised     mutation gates whose operation a case exercises: the cases decide, and the gate is stale,
 *                           reported like a {@code route} entry the server now routes
 * @param gatesNotMutations  mutation gates whose operation F2 does not own: an error in {@code divergences.json}
 */
public record MutationCoverage(String catalogVersion, int mutationOperations, int covered,
                               Map<String, List<String>> families, Map<String, String> gated, List<String> uncovered,
                               List<String> notMutations, List<String> gatesExercised, List<String> gatesNotMutations) {

    /**
     * @param mutations named key of every operation F2 owns, by name-free key
     * @param gates     the {@value DocumentedDivergences#MUTATION_GATE} entries of {@code divergences.json}
     */
    public static MutationCoverage of(String catalogVersion, Map<String, String> mutations, List<MutationFamily> families,
                                      List<DocumentedDivergences.Entry> gates) {
        Map<String, List<String>> byFamily = new TreeMap<>();
        Set<String> exercised = new TreeSet<>();
        Set<String> notMutations = new TreeSet<>();
        for (MutationFamily family : families) {
            Set<String> operations = new TreeSet<>();
            for (MutationCase c : family.cases()) {
                operations.add(c.operation());
                exercised.add(c.operationKey());
                if (!mutations.containsKey(c.operationKey())) {
                    notMutations.add(c.operation());
                }
            }
            byFamily.put(family.name(), List.copyOf(operations));
        }
        Map<String, String> gated = new TreeMap<>();
        Set<String> gatesExercised = new TreeSet<>();
        Set<String> gatesNotMutations = new TreeSet<>();
        Set<String> gatedKeys = new TreeSet<>();
        for (DocumentedDivergences.Entry gate : gates) {
            String key = gate.operationKey();
            if (!mutations.containsKey(key)) {
                gatesNotMutations.add(gate.key());
            } else if (exercised.contains(key)) {
                gatesExercised.add(gate.key());
            } else {
                gated.put(mutations.get(key), reason(gate));
                gatedKeys.add(key);
            }
        }
        List<String> uncovered = mutations.entrySet().stream()
                .filter(e -> !exercised.contains(e.getKey()) && !gatedKeys.contains(e.getKey()))
                .map(Map.Entry::getValue).sorted().toList();
        return new MutationCoverage(catalogVersion, mutations.size(), (int) mutations.keySet().stream()
                .filter(exercised::contains).count(), byFamily, gated, uncovered, List.copyOf(notMutations),
                List.copyOf(gatesExercised), List.copyOf(gatesNotMutations));
    }

    /** The ledger detail of an operation a mutation gate accounts for: its reason and the entry. */
    public static String reason(DocumentedDivergences.Entry gate) {
        return gate.reason() + " [" + gate.ref() + "]";
    }
}
