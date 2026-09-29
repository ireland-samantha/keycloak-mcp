package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import java.nio.file.Path;

/**
 * Run configuration, from the system properties the pom forwards (see {@code equivalence/pom.xml}).
 *
 * @param image           Keycloak image started by Testcontainers when {@code url} is blank
 * @param features        value for {@code --features}; blank keeps the server defaults
 * @param url             external Keycloak to attach to instead of starting a container (dev loop)
 * @param adminUser       bootstrap admin of the master realm, used only to provision the service account
 * @param adminPassword   its password
 * @param keycloakMcpRoot keycloak-mcp checkout whose {@code src/index.js} is spawned
 * @param catalogVersion  {@code KEYCLOAK_MCP_CATALOG_VERSION} for the spawned keycloak-mcp
 * @param node            Node.js executable
 */
public record Settings(String image, String features, String url, String adminUser, String adminPassword,
                       Path keycloakMcpRoot, String catalogVersion, String node) {

    public static Settings fromSystemProperties() {
        return new Settings(
                property("keycloak.image", "quay.io/keycloak/keycloak:nightly"),
                property("keycloak.features", ""),
                property("keycloak.url", ""),
                property("keycloak.admin.user", "admin"),
                property("keycloak.admin.password", "admin"),
                Path.of(property("keycloakmcp.root", "..")).toAbsolutePath().normalize(),
                property("keycloakmcp.catalog", "nightly"),
                property("node.executable", "node"));
    }

    public boolean externalServer() {
        return !url.isBlank();
    }

    private static String property(String name, String fallback) {
        String value = System.getProperty(name);
        return value == null ? fallback : value.strip();
    }
}
