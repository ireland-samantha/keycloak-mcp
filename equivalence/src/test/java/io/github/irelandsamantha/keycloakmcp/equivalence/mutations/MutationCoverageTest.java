package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

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
        MutationCoverage coverage = MutationCoverage.of("latest", mutations, List.of(new Family()));
        assertEquals(2, coverage.mutationOperations());
        assertEquals(1, coverage.covered());
        assertEquals(List.of("POST /admin/realms/{realm}/roles"), coverage.uncovered());
        assertEquals(List.of("GET /admin/realms/{realm}/roles"), coverage.notMutations());
        assertEquals(Map.of("f", List.of("DELETE /admin/realms/{realm}/roles/{role-name}", "GET /admin/realms/{realm}/roles")),
                coverage.families());
    }
}
