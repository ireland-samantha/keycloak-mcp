package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;

import java.util.Map;

/** Case requests as keycloak-mcp's workflow steps: its catalog key and its path variable names. */
final class McpSteps {

    /** A request for an operation keycloak-mcp's catalog does not list. */
    static final class NotInCatalog extends RuntimeException {
        NotInCatalog(String operation) {
            super(operation + " is not in keycloak-mcp's catalog");
        }
    }

    private final Map<String, JsonNode> catalog;

    /** @param catalog describe results by name-free operation key */
    McpSteps(Map<String, JsonNode> catalog) {
        this.catalog = catalog;
    }

    Step step(CaseRequest request) {
        JsonNode listed = catalog.get(request.operationKey());
        if (listed == null) {
            throw new NotInCatalog(request.operation());
        }
        return Step.of(listed.path("key").asText(), request.args().mcpArguments(listed.path("path").asText()));
    }
}
