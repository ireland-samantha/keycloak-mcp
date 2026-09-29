package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class PathValuesTest {

    private final PathValues values = new PathValues(new SeededRealm(null, "r1", Map.of(
            SeededRealm.CLIENT_ID, "client-uuid",
            SeededRealm.CLIENT_SCOPE_ID, "scope-uuid",
            SeededRealm.policy("role"), "role-policy",
            SeededRealm.policy("generic"), "generic-policy",
            SeededRealm.USER_ID, "user-uuid"), List.of()));

    @Test
    void repeatedNamesAreBoundByPositionAndLiteralContext() {
        assertEquals(List.of("r1", "client-uuid", "role-policy"),
                values.valuesFor("/admin/realms/{realm}/clients/{id}/authz/resource-server/policy/role/{id}"));
        assertEquals(List.of("r1", "client-uuid", "generic-policy"),
                values.valuesFor("/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/{policy-id}"));
    }

    @Test
    void namesDoNotMatterOnlyThePrecedingPath() {
        assertEquals(values.valuesFor("/admin/realms/{realm}/users/{user-id}/groups"),
                values.valuesFor("/admin/realms/{r}/users/{id}/groups"));
        assertEquals(List.of("r1", "scope-uuid"), values.valuesFor("/admin/realms/{realm}/default-default-client-scopes/{clientScopeId}"));
    }

    @Test
    void uncoveredVariablesAndFailedSeedingStepsGetTheMissingMarker() {
        assertEquals(List.of("r1", SeededRealm.MISSING), values.valuesFor("/admin/realms/{realm}/sessions/{session}"));
        assertEquals(List.of("r1", SeededRealm.MISSING), values.valuesFor("/admin/realms/{realm}/organizations/{org-id}"));
    }

    @Test
    void prefixCollapsesEarlierVariables() {
        assertEquals("/admin/realms/{}/clients/{}/roles/", PathValues.prefixBefore("/admin/realms/{a}/clients/{b}/roles/{c}", 2));
    }
}
