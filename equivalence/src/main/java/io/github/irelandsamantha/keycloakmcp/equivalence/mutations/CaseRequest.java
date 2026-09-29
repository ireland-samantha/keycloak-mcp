package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

/**
 * A request a case makes, e.g. its compensation.
 *
 * @param operation reference key with variable names, e.g. {@code DELETE /admin/realms/{realm}/groups/{group-id}}
 */
public record CaseRequest(String operation, CaseArgs args) {

    public CaseRequest {
        method(operation);
    }

    public String method() {
        return method(operation);
    }

    /** The path template, variable names as written. */
    public String template() {
        return operation.substring(operation.indexOf(' ') + 1);
    }

    /** Name-free key, as the ledger and every surface join on. */
    public String operationKey() {
        return PathTemplates.operationKey(method(), template());
    }

    private static String method(String operation) {
        int space = operation.indexOf(' ');
        if (space <= 0 || !operation.startsWith("/", space + 1)) {
            throw new IllegalArgumentException("Not 'METHOD /path': " + operation);
        }
        return operation.substring(0, space);
    }
}
