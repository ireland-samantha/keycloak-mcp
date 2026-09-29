package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The Keycloak under test: a Testcontainers-managed {@code start-dev} container of {@link Settings#image()}, or an
 * already running server at {@link Settings#url()}. {@link #systems()} addresses what the server must reach.
 */
public final class KeycloakServer implements AutoCloseable {

    private static final int HTTP_PORT = 8080;
    /** The container's alias on the network it shares with the systems it reaches. */
    private static final String NETWORK_ALIAS = "keycloak";

    private final String baseUrl;
    private final String image;
    private final String imageDigest;
    private final ExternalSystems systems;
    private final GenericContainer<?> container;
    private final Network network;

    private KeycloakServer(String baseUrl, String image, String imageDigest, ExternalSystems systems,
                           GenericContainer<?> container, Network network) {
        this.baseUrl = baseUrl;
        this.image = image;
        this.imageDigest = imageDigest;
        this.systems = systems;
        this.container = container;
        this.network = network;
    }

    public static KeycloakServer start(Settings settings) {
        if (settings.externalServer()) {
            return new KeycloakServer(settings.url().replaceAll("/+$", ""), "external", null,
                    ExternalSystems.external(settings.callbackHost()), null, null);
        }
        Network network = Network.newNetwork();
        GenericContainer<?> container = new GenericContainer<>(DockerImageName.parse(settings.image()))
                .withNetwork(network)
                .withNetworkAliases(NETWORK_ALIAS)
                // Reaching this JVM (the SMTP sink): ports are exposed one at a time by ExternalSystems#jvmPort.
                .withAccessToHost(true)
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
            network.close();
            throw new IllegalStateException("Keycloak container " + settings.image() + " did not start" + logs, e);
        }
        String imageId = container.getContainerInfo().getImageId();
        List<String> digests = container.getDockerClient().inspectImageCmd(imageId).exec().getRepoDigests();
        String digest = digests == null || digests.isEmpty() ? imageId : digests.getFirst();
        // keycloak-mcp accepts plain HTTP only on loopback; Testcontainers maps the port on the Docker host.
        String baseUrl = "http://" + container.getHost() + ":" + container.getMappedPort(HTTP_PORT);
        return new KeycloakServer(baseUrl, settings.image(), digest, ExternalSystems.shared(network), container, network);
    }

    public String baseUrl() {
        return baseUrl;
    }

    /** The systems outside Keycloak the server reaches: ports of this JVM and containers started for it. */
    public ExternalSystems systems() {
        return systems;
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
        try {
            systems.close();
        } finally {
            if (container != null) {
                container.stop();
                network.close();
            }
        }
    }
}
