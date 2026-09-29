package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads.Classification;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads.Classification.Kind;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

class KeycloakMcpPairTest {

    private static final Classification READ = new Classification(Kind.READ, "{\"status\":\"PREFLIGHT_OK\"}");
    private static final Classification MUTATION = new Classification(Kind.MUTATION, KeycloakMcpReads.WRITES_DISABLED);
    private static final Classification REFUSED = new Classification(Kind.REALM_ADMINISTRATION_DISABLED,
            KeycloakMcpReads.REALM_ADMIN_DISABLED);

    private static final KeycloakMcpPair.DryRun NEVER_ASKED = () -> fail("the realm-administration process was asked");

    @Test
    void theRealmAdministrationProcessClassifiesWhatThePinnedOneRefusesForLackOfIt() throws Exception {
        assertEquals(READ, KeycloakMcpPair.resolve(REFUSED, "/admin/serverinfo", () -> READ));
        assertEquals(MUTATION, KeycloakMcpPair.resolve(REFUSED, "/admin/realms", () -> MUTATION));
    }

    @Test
    void anyOtherAnswerOfThePinnedProcessStands() throws Exception {
        assertEquals(READ, KeycloakMcpPair.resolve(READ, "/admin/realms/{realm}/users", NEVER_ASKED));
        assertEquals(MUTATION, KeycloakMcpPair.resolve(MUTATION, "/admin/realms", NEVER_ASKED));
    }

    /** keycloak-mcp gives that refusal only for a path without {realm}, and never with realm administration on. */
    @Test
    void aRefusalThatContradictsKeycloakMcpsRuleIsUnknown() throws Exception {
        Classification realmScoped = KeycloakMcpPair.resolve(REFUSED, "/admin/realms/{realm}/users", NEVER_ASKED);
        assertEquals(Kind.UNKNOWN, realmScoped.kind());
        assertTrue(realmScoped.answer().contains("for a path with {realm}"), realmScoped.answer());
        Classification stillRefused = KeycloakMcpPair.resolve(REFUSED, "/admin/realms", () -> REFUSED);
        assertEquals(Kind.UNKNOWN, stillRefused.kind());
        assertTrue(stillRefused.answer().contains(KeycloakMcpProcess.ALLOW_REALM_ADMIN), stillRefused.answer());
    }

    @Test
    void realmAdministrationIsAddedToTheOtherSwitches() {
        assertEquals(Map.of("KEYCLOAK_MCP_ALLOW_WRITE", "true", KeycloakMcpProcess.ALLOW_REALM_ADMIN, "true"),
                KeycloakMcpPair.withRealmAdministration(Map.of("KEYCLOAK_MCP_ALLOW_WRITE", "true")));
    }
}
