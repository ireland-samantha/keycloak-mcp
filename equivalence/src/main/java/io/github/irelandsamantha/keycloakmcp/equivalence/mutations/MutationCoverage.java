package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Which mutation operations of the reference surface the families exercise. An operation without a case is only
 * proven routed (S3), and the ledger records it as {@code ROUTED_ONLY} until a family covers it.
 *
 * @param catalogVersion     keycloak-mcp catalog the mutation set was classified with
 * @param mutationOperations how many reference operations F2 owns
 * @param covered            how many of them some case exercises
 * @param families           family name to the operations its cases exercise
 * @param uncovered          F2 operations no case exercises, named as the reference names them
 * @param notMutations       case operations F2 does not own (keycloak-mcp classifies them as reads): a family error
 */
public record MutationCoverage(String catalogVersion, int mutationOperations, int covered,
                               Map<String, List<String>> families, List<String> uncovered, List<String> notMutations) {

    /** @param mutations named key of every operation F2 owns, by name-free key */
    public static MutationCoverage of(String catalogVersion, Map<String, String> mutations, List<MutationFamily> families) {
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
        List<String> uncovered = mutations.entrySet().stream().filter(e -> !exercised.contains(e.getKey()))
                .map(Map.Entry::getValue).sorted().toList();
        return new MutationCoverage(catalogVersion, mutations.size(), mutations.size() - uncovered.size(), byFamily,
                uncovered, List.copyOf(notMutations));
    }
}
