package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.DocumentedDivergences;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class MutationCoverageTest {

    private static final class Family implements MutationFamily {
        @Override
        public String name() {
            return "f";
        }

        @Override
        public void seed(CaseContext realm) {
        }

        @Override
        public List<MutationCase> cases() {
            return List.of(mutation("DELETE /admin/realms/{realm}/roles/{role-name}"), mutation("GET /admin/realms/{realm}/roles"));
        }

        private static MutationCase mutation(String operation) {
            return MutationCase.of(operation, "case").args(r -> CaseArgs.path(r.realm()))
                    .readback(Readback.of("GET /admin/realms/{realm}/roles", r -> CaseArgs.path(r.realm())))
                    .irreversible("test").build();
        }
    }

    @Test
    void listsWhatNoCaseExercisesAndCasesOutsideTheMutations() {
        Map<String, String> mutations = Map.of(
                "DELETE /admin/realms/{}/roles/{}", "DELETE /admin/realms/{realm}/roles/{role-name}",
                "POST /admin/realms/{}/roles", "POST /admin/realms/{realm}/roles");
        MutationCoverage coverage = MutationCoverage.of("latest", mutations, List.of(new Family()), List.of());
        assertEquals(2, coverage.mutationOperations());
        assertEquals(1, coverage.covered());
        assertEquals(List.of("POST /admin/realms/{realm}/roles"), coverage.uncovered());
        assertEquals(List.of("GET /admin/realms/{realm}/roles"), coverage.notMutations());
        assertEquals(Map.of("f", List.of("DELETE /admin/realms/{realm}/roles/{role-name}", "GET /admin/realms/{realm}/roles")),
                coverage.families());
    }

    @Test
    void aGateAccountsForAnOperationNoCaseExercisesAndIsStaleOnceOneDoes() {
        Map<String, String> mutations = Map.of(
                "DELETE /admin/realms/{}/roles/{}", "DELETE /admin/realms/{realm}/roles/{role-name}",
                "POST /admin/realms/{}/roles", "POST /admin/realms/{realm}/roles",
                "POST /admin/realms/{}/components", "POST /admin/realms/{realm}/components");
        List<DocumentedDivergences.Entry> gates = DocumentedDivergences.parse(Json.read("""
                {"divergences": [
                  {"key": "POST /admin/realms/{realm}/components", "kind": "mutation-gate", "sources": "environment",
                   "reason": "needs a directory", "evidence": "LDAPStorageProviderFactory.java:1", "since": "2026-09-29"},
                  {"key": "DELETE /admin/realms/{realm}/roles/{name}", "kind": "mutation-gate", "sources": "environment",
                   "reason": "stale", "evidence": "X.java:1", "since": "2026-09-29"},
                  {"key": "GET /admin/realms/{realm}/roles", "kind": "mutation-gate", "sources": "environment",
                   "reason": "a read", "evidence": "X.java:1", "since": "2026-09-29"}]}"""))
                .ofKind(DocumentedDivergences.MUTATION_GATE);
        MutationCoverage coverage = MutationCoverage.of("nightly", mutations, List.of(new Family()), gates);
        assertEquals(1, coverage.covered());
        assertEquals(Map.of("POST /admin/realms/{realm}/components",
                "needs a directory [mutation-gate@environment:POST /admin/realms/{realm}/components]"), coverage.gated());
        assertEquals(List.of("POST /admin/realms/{realm}/roles"), coverage.uncovered());
        assertEquals(List.of("DELETE /admin/realms/{realm}/roles/{name}"), coverage.gatesExercised());
        assertEquals(List.of("GET /admin/realms/{realm}/roles"), coverage.gatesNotMutations());
    }
}
