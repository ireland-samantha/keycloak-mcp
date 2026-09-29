package io.github.irelandsamantha.keycloakmcp.equivalence.surface.model;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.util.List;
import java.util.Set;

/**
 * An operation from a declarative catalog (Keycloak OpenAPI document or the keycloak-mcp catalog as described
 * over MCP), normalised to the fields the surface diff compares.
 *
 * @param method               upper-case HTTP method
 * @param path                 path template as written in the catalog
 * @param declaredPathParams   names of parameters declared {@code in: path}, in declaration order
 * @param tags                 catalog grouping tags
 * @param queryParams          query parameters declared on the operation itself
 * @param pathLevelQueryParams query parameters inherited from the OpenAPI path item (shared by every method
 *                             on that path; empty for sources without path items)
 * @param formParams           field names of form-encoded / multipart request bodies; {@code null} when the source
 *                             does not describe them
 * @param consumes             request body media types
 * @param produces             response media types
 */
public record CatalogOp(
        String method,
        String path,
        List<String> declaredPathParams,
        List<String> tags,
        Set<String> queryParams,
        Set<String> pathLevelQueryParams,
        Set<String> formParams,
        Set<String> consumes,
        Set<String> produces) {

    public String key() {
        return PathTemplates.operationKey(method, path);
    }

    /** Template variable names in path order. */
    public List<String> pathParams() {
        return PathTemplates.variableNames(path);
    }
}
