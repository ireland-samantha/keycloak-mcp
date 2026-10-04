package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class CaseArgsTest {

    @Test
    void keycloakMcpGetsPathValuesByItsOwnNamesWithoutTheRealm() {
        CaseArgs args = CaseArgs.path("twin-a", "g-1", "c-1").withQuery("first", "0").withBody(Json.read("[]"));
        assertEquals(Json.read("""
                {"path": {"group-id": "g-1", "client-id": "c-1"}, "query": {"first": "0"}, "body": []}"""),
                args.mcpArguments("/admin/realms/{realm}/groups/{group-id}/role-mappings/clients/{client-id}"));
    }

    @Test
    void rawRequestsEncodeEachValueAsOneSegment() {
        CaseArgs args = CaseArgs.path("twin a", "../x;y").withQuery("search", "a b");
        assertEquals("/admin/realms/twin%20a/roles/..%2Fx%3By?search=a%20b",
                args.rawPathAndQuery("/admin/realms/{realm}/roles/{role-name}"));
    }

    @Test
    void theValuesMustMatchTheTemplate() {
        assertThrows(IllegalArgumentException.class,
                () -> CaseArgs.path("twin-a").rawPathAndQuery("/admin/realms/{realm}/roles/{role-name}"));
    }
}
