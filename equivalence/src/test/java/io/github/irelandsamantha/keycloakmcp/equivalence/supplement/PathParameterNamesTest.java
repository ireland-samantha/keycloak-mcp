package io.github.irelandsamantha.keycloakmcp.equivalence.supplement;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class PathParameterNamesTest {

    @Test
    void sharedPrefixTakesTheDocumentedNamesAndTheRestKeepJavaNames() {
        PathParameterNames names = new PathParameterNames(List.of(
                "/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy"));
        assertEquals("/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/role/{id}",
                names.harmonize("/admin/realms/{realm}/clients/{id}/authz/resource-server/policy/role/{id}"));
    }

    @Test
    void repeatedJavaNamesAreQualifiedByTheirCollection() {
        assertEquals("/a/{id}/b/{b-id}", new PathParameterNames(List.of()).harmonize("/a/{id}/b/{id}"));
    }

    @Test
    void theMostCommonDocumentedNameWinsAndTiesAreAlphabetical() {
        PathParameterNames names = new PathParameterNames(List.of("/users/{user-id}", "/users/{user-id}/groups", "/users/{id}/x"));
        assertEquals("/users/{user-id}/vc", names.harmonize("/users/{u}/vc"));
        assertEquals("/g/{a}", new PathParameterNames(List.of("/g/{b}", "/g/{a}")).harmonize("/g/{x}"));
    }

    @Test
    void regexConstraintsAreDropped() {
        assertEquals("/g/{path}", new PathParameterNames(List.of()).harmonize("/g/{path: .*}"));
    }
}
