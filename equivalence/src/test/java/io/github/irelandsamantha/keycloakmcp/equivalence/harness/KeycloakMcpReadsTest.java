package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads.Classification.Kind;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.McpStdioClient.ToolResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;

class KeycloakMcpReadsTest {

    private static Kind classify(boolean isError, String text) {
        return KeycloakMcpReads.classification(new ToolResult(isError, text)).kind();
    }

    @Test
    void anAcceptedDryRunIsARead() {
        assertEquals(Kind.READ, classify(false,
                "{\"status\":\"PREFLIGHT_OK\",\"steps\":[{\"operation\":\"GET /admin/realms/{realm}/users\",\"compensation\":null}]}"));
    }

    @Test
    void theWritesDisabledRefusalIsAMutation() {
        assertEquals(Kind.MUTATION, classify(true, "writes are disabled"));
    }

    @Test
    void theRealmAdministrationRefusalIsItsOwnSignal() {
        assertEquals(Kind.REALM_ADMINISTRATION_DISABLED, classify(true, "realm administration is disabled"));
    }

    /** Anything else must not let a raw request through, however close it comes to one of the signals. */
    @ParameterizedTest
    @CsvSource(delimiter = '|', textBlock = """
            true  | missing path parameter: id
            true  | step 1 needs an explicit compensation
            true  | Writes are disabled for this server
            true  | {"status":"PREFLIGHT_OK"}
            true  | Realm administration is disabled
            false | realm administration is disabled
            false | writes are disabled
            false | {"status":"COMPLETED","steps":[]}
            false | {"status":{"value":"PREFLIGHT_OK"}}
            false | [{"status":"PREFLIGHT_OK"}]
            false | PREFLIGHT_OK
            false | ''
            """)
    void anyOtherAnswerIsUnknown(boolean isError, String text) {
        assertEquals(Kind.UNKNOWN, classify(isError, text));
    }
}
