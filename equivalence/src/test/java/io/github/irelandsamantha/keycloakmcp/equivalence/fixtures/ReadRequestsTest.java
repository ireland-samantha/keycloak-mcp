package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.TextNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

class ReadRequestsTest {

    private static final SeededRealm REALM = new SeededRealm(null, "r1", Map.of(
            SeededRealm.USER_ID, "user-uuid", SeededRealm.RESOURCE_ID, "resource-uuid"), List.of());

    private static List<ReadRequest> requests(String method, String template, int variables) {
        return ReadRequests.forOperation(method, template, List.of("r1", "client-uuid", "x").subList(0, variables),
                "application/json", REALM);
    }

    @Test
    void anOperationWithoutAnEntityIsReadOnceAsItIs() {
        List<ReadRequest> reads = requests("GET", "/admin/realms/{realm}/users", 1);
        assertEquals(1, reads.size());
        assertNull(reads.getFirst().variant());
        assertNull(reads.getFirst().body());
        JsonNode value = new TextNode("unchanged");
        assertSame(value, reads.getFirst().view().apply(value));
    }

    @Test
    void policyAndPermissionEvaluationAskForTheSeededUserAndResource() {
        for (String kind : List.of("policy", "permission")) {
            List<ReadRequest> reads = requests("POST", "/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/"
                    + kind + "/evaluate", 2);
            assertEquals(1, reads.size(), kind);
            assertEquals(Json.read("""
                    {"userId": "user-uuid", "resources": [{"_id": "resource-uuid"}], "context": {"attributes": {}},
                     "entitlements": false}"""), reads.getFirst().body().mcpValue(), kind);
        }
    }

    @Test
    void theKeystoreDownloadIsReadInEveryFormatWithItsPasswords() {
        List<ReadRequest> reads = requests("POST", "/admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/download", 3);
        assertEquals(List.of("JKS", "PKCS12"), reads.stream().map(ReadRequest::variant).toList());
        for (ReadRequest read : reads) {
            JsonNode config = read.body().mcpValue();
            assertEquals(read.variant(), config.path("format").asText());
            assertEquals(ReadRequests.STORE_PASSWORD, config.path("storePassword").asText());
            assertEquals(ReadRequests.CLIENT_ALIAS, config.path("keyAlias").asText());
            assertEquals(ReadRequests.REALM_ALIAS, config.path("realmAlias").asText());
            assertEquals("application/json", read.body().mediaType());
        }
    }
}
