package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;

import java.util.Map;
import java.util.SortedSet;
import java.util.TreeSet;

/**
 * The surface keycloak-mcp must equal: every operation of the HEAD OpenAPI definition and of the Java admin client,
 * joined by name-free key. Neither alone suffices: OpenAPI omits operations behind {@code Object}-returning locators,
 * the admin client lags HEAD and lacks OpenAPI-only aliases.
 */
public record ReferenceSurface(Map<String, OpView> openApi, Map<String, OpView> adminClient) {

    public static final String OPENAPI = "openapi";
    public static final String ADMIN_CLIENT = "admin-client";

    public static ReferenceSurface of(JsonNode openApiDocument, WalkResult adminClientWalk) {
        return new ReferenceSurface(OpView.fromCatalog(OpenApiCatalog.parse(openApiDocument)),
                OpView.fromAdminClient(adminClientWalk.endpoints()));
    }

    public SortedSet<String> keys() {
        SortedSet<String> keys = new TreeSet<>(openApi.keySet());
        keys.addAll(adminClient.keySet());
        return keys;
    }

    /** The operation as its primary source defines it: OpenAPI when documented there, else the admin client. */
    public OpView primary(String key) {
        OpView documented = openApi.get(key);
        return documented != null ? documented : adminClient.get(key);
    }
}
