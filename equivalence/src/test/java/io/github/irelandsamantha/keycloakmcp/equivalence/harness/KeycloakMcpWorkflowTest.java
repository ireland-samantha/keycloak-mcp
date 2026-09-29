package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Compensation;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.StepRun;
import org.junit.jupiter.api.Test;

import java.util.List;

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
        assertEquals(List.of(), refused.completed());
        assertEquals(List.of(), refused.rollback());
    }

    @Test
    void aCompletedRunReportsEachStepsStatus() {
        Result run = new Result(false, """
                {"runId": "r", "status": "COMPLETED", "completed": [{"operation": "%s", "status": 201}]}""".formatted(CREATE));
        assertEquals(KeycloakMcpWorkflow.COMPLETED, run.status());
        assertEquals(List.of(new StepRun(CREATE, 201)), run.completed());
        assertNull(run.failedOperation());
        assertEquals(List.of(), run.rollback());
    }

    @Test
    void anInDoubtRunNamesTheFailureAndItsRollback() {
        Result run = new Result(false, """
                {"status": "IN_DOUBT", "failedOperation": "%1$s", "error": "Keycloak operation failed (HTTP 409; attempts 1)",
                 "completed": [{"operation": "%1$s", "status": 201}],
                 "rollback": [{"operation": "%2$s", "outcome": "COMPENSATED"}, {"operation": "%2$s", "outcome": "FAILED"}]}"""
                .formatted(CREATE, DELETE));
        assertEquals(CREATE, run.failedOperation());
        assertEquals(409, run.failureStatus());
        assertEquals(List.of(new StepRun(CREATE, 201)), run.completed());
        assertEquals(List.of(new Compensation(DELETE, KeycloakMcpWorkflow.COMPENSATED), new Compensation(DELETE, "FAILED")),
                run.rollback());
    }

    @Test
    void aFailureWithoutAStatusNamesNone() {
        assertEquals(0, new Result(false, "{\"status\": \"IN_DOUBT\", \"error\": \"create succeeded without a Location\"}")
                .failureStatus());
    }
}
