package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.core.JsonProcessingException;
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
 * request. It fails closed, because a read is then sent raw to the live server: only keycloak-mcp's two explicit
 * answers classify. A plan it accepts ({@value #PREFLIGHT_OK}) is a read; its refusal {@value #WRITES_DISABLED}
 * (keycloak-mcp runs without {@code KEYCLOAK_MCP_ALLOW_WRITE}) is a mutation. Any other answer is
 * {@link Classification.Kind#UNKNOWN}.
 */
public final class KeycloakMcpReads {

    /** Refusal of a plan that contains a mutation while writes are off. */
    public static final String WRITES_DISABLED = "writes are disabled";

    /** Status of a dry run whose plan passed preflight. */
    public static final String PREFLIGHT_OK = "PREFLIGHT_OK";

    private static final Pattern HTTP_STATUS = Pattern.compile("\\bHTTP (\\d{3})\\b");

    /** How keycloak-mcp classified an operation, with its answer verbatim. */
    public record Classification(Kind kind, String answer) {
        public enum Kind { READ, MUTATION, UNKNOWN }
    }

    private KeycloakMcpReads() {
    }

    /**
     * keycloak-mcp's classification of {@code operation}, judged without sending any request.
     *
     * @param args the arguments the read would carry, so that a {@link Classification.Kind#READ} also means
     *             keycloak-mcp accepts them
     */
    public static Classification classify(McpStdioClient mcp, String operation, JsonNode args)
            throws IOException, InterruptedException, TimeoutException {
        ObjectNode call = McpStdioClient.JSON.createObjectNode().put("execute", false);
        call.putArray("steps").addObject().put("operation", operation).set("args", args);
        return classification(mcp.callTool("keycloak_workflow", call));
    }

    static Classification classification(McpStdioClient.ToolResult dryRun) {
        boolean read = !dryRun.isError() && PREFLIGHT_OK.equals(status(dryRun.text()));
        boolean mutation = dryRun.isError() && WRITES_DISABLED.equals(dryRun.text());
        Classification.Kind kind = read ? Classification.Kind.READ
                : mutation ? Classification.Kind.MUTATION : Classification.Kind.UNKNOWN;
        return new Classification(kind, dryRun.text());
    }

    private static String status(String text) {
        try {
            JsonNode status = McpStdioClient.JSON.readTree(text).path("status");
            return status.isTextual() ? status.asText() : null;
        } catch (JsonProcessingException e) {
            return null;
        }
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
            return Observation.failure(httpStatus(result.text()), result.text());
        }
        JsonNode answer = result.json();
        JsonNode value = answer.get("value");
        return new Observation(answer.path("status").asInt(), value == null ? NullNode.getInstance() : value, null);
    }

    /** The HTTP status a keycloak-mcp error message names ({@code ... HTTP 404 ...}), 0 when it names none. */
    static int httpStatus(String message) {
        Matcher status = HTTP_STATUS.matcher(message);
        return status.find() ? Integer.parseInt(status.group(1)) : 0;
    }
}
