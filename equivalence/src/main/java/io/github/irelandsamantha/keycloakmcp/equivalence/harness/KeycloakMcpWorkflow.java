package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.MissingNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeoutException;

/** keycloak-mcp's {@code keycloak_workflow} tool as an MCP client drives it. */
public final class KeycloakMcpWorkflow {

    /** Compensation path value that keycloak-mcp replaces with the id in the created resource's {@code Location}. */
    public static final String LOCATION_ID = "$step.locationId";

    /** Compensation path value that keycloak-mcp replaces with the id in the create response's body. */
    public static final String RESPONSE_ID = "$step.responseId";

    public static final String PREFLIGHT_OK = "PREFLIGHT_OK";
    public static final String COMPLETED = "COMPLETED";
    public static final String IN_DOUBT = "IN_DOUBT";

    /** Outcome of a compensation that ran and succeeded, in a run's {@code rollback}. */
    public static final String COMPENSATED = "COMPENSATED";

    /**
     * One step as the tool takes it.
     *
     * @param args         {@code {path, query, body}}; path values are named after the catalog's variables
     * @param compensation {@code null} for none
     * @param irreversible the caller's explicit override for a step keycloak-mcp gates as irreversible
     */
    public record Step(String operation, JsonNode args, Step compensation, boolean irreversible) {

        public static Step of(String operation, JsonNode args) {
            return new Step(operation, args, null, false);
        }

        public Step compensatedBy(Step compensation) {
            return new Step(operation, args, compensation, irreversible);
        }

        public Step markedIrreversible() {
            return new Step(operation, args, compensation, true);
        }

        ObjectNode toJson() {
            ObjectNode step = McpStdioClient.JSON.createObjectNode().put("operation", operation);
            step.set("args", args);
            if (compensation != null) {
                step.putObject("compensate").put("operation", compensation.operation()).set("args", compensation.args());
            }
            if (irreversible) {
                step.put("irreversible", true);
            }
            return step;
        }
    }

    /**
     * The tool's answer: a refusal ({@code isError}, with keycloak-mcp's message) or a plan or run report.
     *
     * @param refused whether the tool answered with an error: nothing was run
     * @param text    the answer verbatim
     */
    public record Result(boolean refused, String text) {

        /** The report as JSON; missing for a refusal or an answer that is not JSON. */
        public JsonNode report() {
            if (refused) {
                return MissingNode.getInstance();
            }
            try {
                return McpStdioClient.JSON.readTree(text);
            } catch (JsonProcessingException e) {
                return MissingNode.getInstance();
            }
        }

        /** {@code PREFLIGHT_OK}, {@code COMPLETED}, {@code IN_DOUBT}; {@code null} for a refusal. */
        public String status() {
            JsonNode status = report().path("status");
            return status.isTextual() ? status.asText() : null;
        }

        /** HTTP status of completed step {@code index}, 0 when that step did not complete. */
        public int completedStatus(int index) {
            return report().path("completed").path(index).path("status").asInt(0);
        }

        /** HTTP status named by the failure of an {@code IN_DOUBT} run, 0 when it names none. */
        public int failureStatus() {
            return KeycloakMcpReads.httpStatus(report().path("error").asText(""));
        }

        /** Whether every compensation of an {@code IN_DOUBT} run succeeded. */
        public boolean everyCompensationSucceeded() {
            JsonNode rollback = report().path("rollback");
            for (JsonNode entry : rollback) {
                if (!COMPENSATED.equals(entry.path("outcome").asText())) {
                    return false;
                }
            }
            return true;
        }
    }

    private KeycloakMcpWorkflow() {
    }

    /** Plans ({@code execute=false}) or runs the steps. */
    public static Result call(McpStdioClient mcp, List<Step> steps, boolean execute)
            throws IOException, InterruptedException, TimeoutException {
        ObjectNode call = McpStdioClient.JSON.createObjectNode().put("execute", execute);
        ArrayNode array = call.putArray("steps");
        steps.forEach(step -> array.add(step.toJson()));
        McpStdioClient.ToolResult result = mcp.callTool("keycloak_workflow", call);
        return new Result(result.isError(), result.text());
    }
}
