package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.testcontainers.Testcontainers;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The Keycloak under test: a Testcontainers-managed {@code start-dev} container of {@link Settings#image()}, or an
 * already running server at {@link Settings#url()}.
 */
public final class KeycloakServer implements AutoCloseable {

    private static final int HTTP_PORT = 8080;
    private static final String CONTAINER_CALLBACK_HOST = "host.testcontainers.internal";

    private final String baseUrl;
    private final String image;
    private final String imageDigest;
    private final String callbackHost;
    private final GenericContainer<?> container;

    private KeycloakServer(String baseUrl, String image, String imageDigest, String callbackHost,
                           GenericContainer<?> container) {
        this.baseUrl = baseUrl;
        this.image = image;
        this.imageDigest = imageDigest;
        this.callbackHost = callbackHost;
        this.container = container;
    }

    /** @param hostPorts ports of this JVM the server must be able to reach under {@link #callbackHost()} */
    public static KeycloakServer start(Settings settings, int... hostPorts) {
        if (settings.externalServer()) {
            return new KeycloakServer(settings.url().replaceAll("/+$", ""), "external", null, settings.callbackHost(), null);
        }
        Testcontainers.exposeHostPorts(hostPorts);
        GenericContainer<?> container = new GenericContainer<>(DockerImageName.parse(settings.image()))
                .withExposedPorts(HTTP_PORT)
                .withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", settings.adminUser())
                .withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", settings.adminPassword())
                .withCommand(command(settings.features()))
                .waitingFor(Wait.forHttp("/realms/master").forPort(HTTP_PORT).forStatusCode(200)
                        .withStartupTimeout(Duration.ofMinutes(5)));
        try {
            container.start();
        } catch (RuntimeException e) {
            String logs = container.getContainerId() == null ? "" : "\n" + container.getLogs();
            container.stop();
            throw new IllegalStateException("Keycloak container " + settings.image() + " did not start" + logs, e);
        }
        String imageId = container.getContainerInfo().getImageId();
        List<String> digests = container.getDockerClient().inspectImageCmd(imageId).exec().getRepoDigests();
        String digest = digests == null || digests.isEmpty() ? imageId : digests.getFirst();
        // keycloak-mcp accepts plain HTTP only on loopback; Testcontainers maps the port on the Docker host.
        String baseUrl = "http://" + container.getHost() + ":" + container.getMappedPort(HTTP_PORT);
        return new KeycloakServer(baseUrl, settings.image(), digest, CONTAINER_CALLBACK_HOST, container);
    }

    public String baseUrl() {
        return baseUrl;
    }

    /** Host name or address under which the server reaches this JVM. */
    public String callbackHost() {
        return callbackHost;
    }

    /** What was started; "external" when attached to {@code keycloak.url}. */
    public String image() {
        return image;
    }

    /** Repository digest of the started image; {@code null} for an external server, whose image is not observable. */
    public String imageDigest() {
        return imageDigest;
    }

    private static String[] command(String features) {
        List<String> args = new ArrayList<>(List.of("start-dev"));
        if (!features.isBlank()) {
            args.add("--features=" + features);
        }
        return args.toArray(String[]::new);
    }

    @Override
    public void close() {
        if (container != null) {
            container.stop();
        }
    }
}
