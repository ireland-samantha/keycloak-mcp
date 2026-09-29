package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads.Classification;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeoutException;

/**
 * keycloak-mcp as the functional checks drive it: one process pinned to a realm with realm administration off, as
 * keycloak-mcp ships, and a twin with {@link KeycloakMcpProcess#ALLOW_REALM_ADMIN} for exactly the operations without
 * {@code {realm}}, which the pinned process refuses as {@value KeycloakMcpReads#REALM_ADMIN_DISABLED}
 * ({@code SafetySemanticsIT} proves that refusal). Every other operation runs in the pinned process, so the switch
 * reaches no operation that does not need it.
 */
public final class KeycloakMcpPair implements AutoCloseable {

    /** One classification: whether a process accepts {@code operation} as a read, without sending anything. */
    @FunctionalInterface
    interface DryRun {
        Classification classify() throws IOException, InterruptedException, TimeoutException;
    }

    private final KeycloakMcpProcess pinned;
    private final KeycloakMcpProcess realmAdministration;

    private KeycloakMcpPair(KeycloakMcpProcess pinned, KeycloakMcpProcess realmAdministration) {
        this.pinned = pinned;
        this.realmAdministration = realmAdministration;
    }

    /** Starts both processes pinned to {@code realm}, with {@code switches} as {@link KeycloakMcpProcess#start} takes them. */
    public static KeycloakMcpPair start(EquivalenceEnvironment env, String realm, Map<String, String> switches)
            throws IOException, InterruptedException, TimeoutException {
        KeycloakMcpProcess pinned = env.startKeycloakMcp(realm, switches);
        try {
            return new KeycloakMcpPair(pinned, env.startKeycloakMcp(realm, withRealmAdministration(switches)));
        } catch (IOException | InterruptedException | TimeoutException | RuntimeException e) {
            pinned.close();
            throw e;
        }
    }

    /** {@code switches} with {@link KeycloakMcpProcess#ALLOW_REALM_ADMIN} on. */
    public static Map<String, String> withRealmAdministration(Map<String, String> switches) {
        Map<String, String> out = new HashMap<>(switches);
        out.put(KeycloakMcpProcess.ALLOW_REALM_ADMIN, "true");
        return out;
    }

    /** The process as keycloak-mcp ships: realm administration off. */
    public McpStdioClient pinned() {
        return pinned.client();
    }

    /** The process an operation of this catalog path runs in. */
    public McpStdioClient forPath(String catalogPath) {
        return KeycloakMcpProcess.needsRealmAdministration(catalogPath) ? realmAdministration.client() : pinned.client();
    }

    /**
     * keycloak-mcp's classification of {@code operation} (see {@link KeycloakMcpReads#classify}), asked of the pinned
     * process first; see {@link #resolve} for when the realm-administration process answers instead.
     */
    public Classification classify(String operation, String catalogPath, JsonNode args)
            throws IOException, InterruptedException, TimeoutException {
        return resolve(KeycloakMcpReads.classify(pinned.client(), operation, args), catalogPath,
                () -> KeycloakMcpReads.classify(realmAdministration.client(), operation, args));
    }

    /**
     * The pinned process's classification, unless it refused an operation without {@code {realm}} as
     * {@value KeycloakMcpReads#REALM_ADMIN_DISABLED}: then the realm-administration process classifies it. The same
     * refusal for an operation with {@code {realm}}, or from the process that has realm administration, contradicts
     * keycloak-mcp's own rule and is {@link Classification.Kind#UNKNOWN}, so nothing is sent for it.
     */
    static Classification resolve(Classification pinned, String catalogPath, DryRun realmAdministration)
            throws IOException, InterruptedException, TimeoutException {
        if (pinned.kind() != Classification.Kind.REALM_ADMINISTRATION_DISABLED) {
            return pinned;
        }
        if (!KeycloakMcpProcess.needsRealmAdministration(catalogPath)) {
            return unknown(pinned, "for a path with {realm}");
        }
        Classification lifted = realmAdministration.classify();
        return lifted.kind() == Classification.Kind.REALM_ADMINISTRATION_DISABLED
                ? unknown(lifted, "with " + KeycloakMcpProcess.ALLOW_REALM_ADMIN + "=true") : lifted;
    }

    private static Classification unknown(Classification refusal, String context) {
        return new Classification(Classification.Kind.UNKNOWN, refusal.answer() + " (" + context + ")");
    }

    @Override
    public void close() {
        try {
            realmAdministration.close();
        } finally {
            pinned.close();
        }
    }
}
