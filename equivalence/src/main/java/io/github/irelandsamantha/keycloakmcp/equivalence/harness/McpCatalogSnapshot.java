package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeoutException;

/**
 * keycloak-mcp's operation catalog exactly as an MCP client sees it: every key from paginated
 * {@code keycloak_search_operations}, each expanded with {@code keycloak_describe_operation}. Reading through the
 * tools (not {@code data/*.json}) is the point: runtime corrections and supplements are included, and pagination
 * itself is exercised.
 *
 * @param version      {@code KEYCLOAK_MCP_CATALOG_VERSION} the server was started with
 * @param source       catalog source the server reports
 * @param sourceSha256 digest of that source the server reports
 * @param operations   describe results, in search order
 */
public record McpCatalogSnapshot(String version, String source, String sourceSha256, List<JsonNode> operations) {

    private static final int PAGE = 100;

    public static McpCatalogSnapshot read(McpStdioClient mcp, String version)
            throws IOException, InterruptedException, TimeoutException {
        Set<String> keys = new LinkedHashSet<>();
        JsonNode first = null;
        int total = Integer.MAX_VALUE;
        for (int offset = 0; offset < total; offset += PAGE) {
            ObjectNode args = McpStdioClient.JSON.createObjectNode().put("offset", offset).put("limit", PAGE);
            JsonNode page = expect(mcp.callTool("keycloak_search_operations", args), "search offset " + offset);
            if (first == null) {
                first = page;
                total = page.path("total").asInt();
            } else if (page.path("total").asInt() != total) {
                throw new IllegalStateException("Catalog total changed while paginating: " + total + " -> " + page.path("total"));
            }
            JsonNode ops = page.path("operations");
            if (ops.isEmpty() && offset < total) {
                throw new IllegalStateException("Empty page at offset " + offset + " of " + total);
            }
            ops.forEach(op -> {
                if (!keys.add(op.path("key").asText())) {
                    throw new IllegalStateException("Operation listed twice while paginating: " + op.path("key"));
                }
            });
        }
        if (keys.size() != total) {
            throw new IllegalStateException("Pagination returned " + keys.size() + " keys, total says " + total);
        }
        List<JsonNode> described = new ArrayList<>(keys.size());
        for (String key : keys) {
            ObjectNode args = McpStdioClient.JSON.createObjectNode().put("operation", key);
            JsonNode op = expect(mcp.callTool("keycloak_describe_operation", args), "describe " + key);
            if (!key.equals(op.path("key").asText())) {
                throw new IllegalStateException("describe " + key + " answered for " + op.path("key"));
            }
            described.add(op);
        }
        return new McpCatalogSnapshot(version, first.path("source").asText(), first.path("sourceSha256").asText(),
                List.copyOf(described));
    }

    private static JsonNode expect(McpStdioClient.ToolResult result, String what) {
        if (result.isError()) {
            throw new IllegalStateException(what + " failed: " + result.text());
        }
        return result.json();
    }
}
