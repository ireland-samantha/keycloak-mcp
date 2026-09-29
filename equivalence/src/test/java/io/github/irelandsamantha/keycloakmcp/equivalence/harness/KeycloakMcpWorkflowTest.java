package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class KeycloakMcpWorkflowTest {

    private static final String CREATE = "POST /admin/realms/{realm}/groups";
    private static final String DELETE = "DELETE /admin/realms/{realm}/groups/{group-id}";

    @Test
    void aStepCarriesItsCompensationAndOverride() throws Exception {
        JsonNode args = McpStdioClient.JSON.readTree("{\"body\":{\"name\":\"g\"}}");
        JsonNode undo = McpStdioClient.JSON.readTree("{\"path\":{\"group-id\":\"$step.locationId\"}}");
        JsonNode step = Step.of(CREATE, args).compensatedBy(Step.of(DELETE, undo)).markedIrreversible().toJson();
        assertEquals(McpStdioClient.JSON.readTree("""
                {"operation": "POST /admin/realms/{realm}/groups", "args": {"body": {"name": "g"}},
                 "compensate": {"operation": "DELETE /admin/realms/{realm}/groups/{group-id}",
                                "args": {"path": {"group-id": "$step.locationId"}}},
                 "irreversible": true}"""), step);
        assertFalse(Step.of(CREATE, args).toJson().has("irreversible"), "no override unless asked for");
    }

    @Test
    void aRefusalHasNoReport() {
        Result refused = new Result(true, "writes are disabled");
        assertNull(refused.status());
        assertTrue(refused.report().isMissingNode());
    }

    @Test
    void aCompletedRunReportsEachStepsStatus() {
        Result run = new Result(false, """
                {"runId": "r", "status": "COMPLETED", "completed": [{"operation": "%s", "status": 201}]}""".formatted(CREATE));
        assertEquals(KeycloakMcpWorkflow.COMPLETED, run.status());
        assertEquals(201, run.completedStatus(0));
        assertEquals(0, run.completedStatus(1));
    }

    @Test
    void anInDoubtRunNamesTheFailureAndItsRollback() {
        Result run = new Result(false, """
                {"status": "IN_DOUBT", "error": "Keycloak operation failed (HTTP 409; attempts 1)",
                 "rollback": [{"outcome": "COMPENSATED"}, {"outcome": "FAILED"}]}""");
        assertEquals(409, run.failureStatus());
        assertFalse(run.everyCompensationSucceeded());
        assertTrue(new Result(false, "{\"status\": \"IN_DOUBT\", \"rollback\": [{\"outcome\": \"COMPENSATED\"}]}")
                .everyCompensationSucceeded());
    }

    @Test
    void aFailureWithoutAStatusNamesNone() {
        assertEquals(0, new Result(false, "{\"status\": \"IN_DOUBT\", \"error\": \"create succeeded without a Location\"}")
                .failureStatus());
    }
}
