package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

/**
 * Run configuration, from the system properties the pom forwards (see {@code equivalence/pom.xml}).
 *
 * @param image           Keycloak image started by Testcontainers when {@code url} is blank
 * @param features        value for {@code --features}; blank keeps the server defaults. Defaults to
 *                        {@link #MAXIMAL_FEATURES}; the pom explains the choice
 * @param url             external Keycloak to attach to instead of starting a container (dev loop)
 * @param adminUser       bootstrap admin of the master realm, used only to provision the service account
 * @param adminPassword   its password
 * @param keycloakMcpRoot keycloak-mcp checkout whose {@code src/index.js} is spawned
 * @param catalogVersion  {@code KEYCLOAK_MCP_CATALOG_VERSION} for the spawned keycloak-mcp
 * @param node            Node.js executable
 * @param callbackHost    host the Keycloak server reaches this JVM under (for the {@link SmtpSink}) when attached
 *                        to {@code url}; a container always uses Testcontainers' host alias
 * @param families        names of the mutation families the mutation checks run; empty runs every family
 */
public record Settings(String image, String features, String url, String adminUser, String adminPassword,
                       Path keycloakMcpRoot, String catalogVersion, String node, String callbackHost,
                       List<String> families) {

    public Settings {
        families = List.copyOf(families);
    }

    /** The feature profile that exercises the most reference operations (see {@code keycloak.features} in the pom). */
    public static final String MAXIMAL_FEATURES = "preview,client-types,admin-fine-grained-authz:v1";

    public static Settings fromSystemProperties() {
        return new Settings(
                property("keycloak.image", "quay.io/keycloak/keycloak:nightly"),
                property("keycloak.features", MAXIMAL_FEATURES),
                property("keycloak.url", ""),
                property("keycloak.admin.user", "admin"),
                property("keycloak.admin.password", "admin"),
                Path.of(property("keycloakmcp.root", "..")).toAbsolutePath().normalize(),
                property("keycloakmcp.catalog", "nightly"),
                property("node.executable", "node"),
                // Docker's default bridge gateway: where a container started with "-p" reaches its host.
                property("keycloak.callback.host", "172.17.0.1"),
                commaList(property("equivalence.families", "")));
    }

    /** The non-blank items of a comma-separated list, stripped; empty for a blank list. */
    static List<String> commaList(String value) {
        return Arrays.stream(value.split(",")).map(String::strip).filter(item -> !item.isEmpty()).distinct().toList();
    }

    public boolean externalServer() {
        return !url.isBlank();
    }

    private static String property(String name, String fallback) {
        String value = System.getProperty(name);
        return value == null ? fallback : value.strip();
    }
}
