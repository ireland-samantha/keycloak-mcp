package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.testcontainers.Testcontainers;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Systems outside Keycloak that the server under test must reach, each addressed as the server sees it: a port of
 * this JVM (the SMTP sink, an HTTP sink for back-channel calls) or a container (an LDAP directory).
 *
 * <ul>
 *   <li>With a Testcontainers server, the Keycloak container shares a Docker network with every container started
 *       here and reaches each by its network alias; it reaches this JVM as {@value #TESTCONTAINERS_HOST}, one
 *       exposed port at a time.</li>
 *   <li>With an external server ({@code keycloak.url}), the server reaches the Docker host as
 *       {@code keycloak.callback.host} (Docker's bridge gateway {@code 172.17.0.1} for a server container started
 *       with {@code -p}): a JVM port directly, and a container started here through the port it publishes.</li>
 * </ul>
 *
 * A container is started once per run, on first use under its alias, and stopped with the environment.
 */
public final class ExternalSystems implements AutoCloseable {

    /** Testcontainers' name for the Docker host inside a container started with host access. */
    static final String TESTCONTAINERS_HOST = "host.testcontainers.internal";

    /** Where the server reaches a system. */
    public record Address(String host, int port) {
        public String hostAndPort() {
            return host + ":" + port;
        }
    }

    /**
     * A started container and where the server reaches its port; this JVM reaches the same port at
     * {@code container.getHost()} and {@code container.getMappedPort(port)}.
     */
    public record Sidecar(GenericContainer<?> container, Address fromServer) {
    }

    private final Network network;
    private final String callbackHost;
    private final Map<String, Sidecar> sidecars = new LinkedHashMap<>();

    private ExternalSystems(Network network, String callbackHost) {
        this.network = network;
        this.callbackHost = callbackHost;
    }

    /** For a Testcontainers server attached to {@code network} with host access. */
    static ExternalSystems shared(Network network) {
        return new ExternalSystems(network, TESTCONTAINERS_HOST);
    }

    /** For an external server that reaches the Docker host as {@code callbackHost}. */
    static ExternalSystems external(String callbackHost) {
        return new ExternalSystems(null, callbackHost);
    }

    /** A port this JVM listens on, as the server reaches it. */
    public synchronized Address jvmPort(int port) {
        if (network != null) {
            Testcontainers.exposeHostPorts(port);
        }
        return new Address(callbackHost, port);
    }

    /**
     * The container {@code alias}, started from {@code definition} on first use, and where the server reaches its
     * {@code port}. The definition must not choose a network; the alias names the container in both modes. The port
     * is also published, so the container's wait strategy (by default: the port listens) holds in both modes.
     */
    public synchronized Sidecar container(String alias, int port, Supplier<? extends GenericContainer<?>> definition) {
        Sidecar started = sidecars.get(alias);
        if (started != null) {
            return started;
        }
        GenericContainer<?> container = definition.get();
        container.addExposedPort(port);
        if (network != null) {
            container.withNetwork(network).withNetworkAliases(alias);
        }
        container.start();
        Address fromServer = network != null ? new Address(alias, port) : new Address(callbackHost, container.getMappedPort(port));
        started = new Sidecar(container, fromServer);
        sidecars.put(alias, started);
        return started;
    }

    /** Stops the containers, the last started first. */
    @Override
    public synchronized void close() {
        List<Sidecar> started = new ArrayList<>(sidecars.values());
        sidecars.clear();
        RuntimeException failure = null;
        for (Sidecar sidecar : started.reversed()) {
            try {
                sidecar.container().stop();
            } catch (RuntimeException e) {
                failure = failure == null ? e : failure;
            }
        }
        if (failure != null) {
            throw failure;
        }
    }
}
