package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Collections;
import java.util.Map;

import static io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpProcess.ALLOW_SENSITIVE_READS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class KeycloakMcpProcessTest {

    private static Map<String, String> environment(Map<String, String> switches) {
        return KeycloakMcpProcess.environment(Path.of("/private/home"), Path.of("/private/home/config.json"),
                Path.of("/private/home/journal"), "nightly", switches);
    }

    @Test
    void equivalenceReadsUnredactedUnlessTheCallerSaysOtherwise() {
        assertEquals("true", environment(Map.of()).get(ALLOW_SENSITIVE_READS));
        assertEquals("false", environment(Map.of(ALLOW_SENSITIVE_READS, "false")).get(ALLOW_SENSITIVE_READS));
    }

    @Test
    void aNullSwitchLeavesItUnsetSoTheShippedDefaultApplies() {
        Map<String, String> env = environment(Collections.singletonMap(ALLOW_SENSITIVE_READS, null));
        assertFalse(env.containsKey(ALLOW_SENSITIVE_READS), env::toString);
        assertFalse(env.containsValue(null), env::toString);
    }

    @Test
    void theProcessGetsAPrivateHomeConfigAndJournal() {
        assertEquals(Map.of("HOME", "/private/home", "KEYCLOAK_MCP_CONFIG", "/private/home/config.json",
                        "KEYCLOAK_MCP_CATALOG_VERSION", "nightly", ALLOW_SENSITIVE_READS, "true",
                        "KEYCLOAK_MCP_JOURNAL_DIR", "/private/home/journal", "KEYCLOAK_MCP_ALLOW_WRITE", "true"),
                environment(Map.of("KEYCLOAK_MCP_ALLOW_WRITE", "true")));
    }
}
