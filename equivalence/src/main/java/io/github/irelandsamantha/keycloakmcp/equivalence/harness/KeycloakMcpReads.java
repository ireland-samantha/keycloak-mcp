package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Observation;

import java.io.IOException;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * keycloak-mcp's read tool and its read/mutation classification, as an MCP client observes them.
 *
 * <p>The classification is read from a dry run: {@code keycloak_workflow} with {@code execute=false} never sends a
 * request, and a keycloak-mcp without {@code KEYCLOAK_MCP_ALLOW_WRITE} refuses any plan containing a mutation with
 * {@link #WRITES_DISABLED} before anything else is checked.
 */
public final class KeycloakMcpReads {

    /** Refusal of a plan that contains a mutation while writes are off. */
    public static final String WRITES_DISABLED = "writes are disabled";

    private static final Pattern HTTP_STATUS = Pattern.compile("\\bHTTP (\\d{3})\\b");

    private KeycloakMcpReads() {
    }

    /** Whether keycloak-mcp classifies {@code operation} as a mutation, judged without sending any request. */
    public static boolean classifiesAsMutation(McpStdioClient mcp, String operation)
            throws IOException, InterruptedException, TimeoutException {
        ObjectNode args = McpStdioClient.JSON.createObjectNode().put("execute", false);
        args.putArray("steps").addObject().put("operation", operation);
        McpStdioClient.ToolResult result = mcp.callTool("keycloak_workflow", args);
        return result.isError() && result.text().contains(WRITES_DISABLED);
    }

    /**
     * {@code keycloak_read} as an observation: a success carries the status and decoded value keycloak-mcp reports;
     * a failure carries the HTTP status its message names, or 0 when it sent no request.
     */
    public static Observation read(McpStdioClient mcp, String operation, JsonNode args)
            throws IOException, InterruptedException, TimeoutException {
        ObjectNode call = McpStdioClient.JSON.createObjectNode().put("operation", operation);
        call.set("args", args);
        McpStdioClient.ToolResult result = mcp.callTool("keycloak_read", call);
        if (result.isError()) {
            Matcher status = HTTP_STATUS.matcher(result.text());
            return Observation.failure(status.find() ? Integer.parseInt(status.group(1)) : 0, result.text());
        }
        JsonNode answer = result.json();
        JsonNode value = answer.get("value");
        return new Observation(answer.path("status").asInt(), value == null ? NullNode.getInstance() : value, null);
    }
}
