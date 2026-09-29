package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.keycloak.admin.client.CreatedResponseUtil;
import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.resource.RealmResource;
import org.keycloak.representations.idm.ClientRepresentation;
import org.keycloak.representations.idm.RoleRepresentation;
import org.keycloak.representations.idm.UserRepresentation;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;

/**
 * The confidential master-realm client keycloak-mcp and the raw-HTTP oracle both authenticate as, so the two see
 * exactly the same permissions: service accounts enabled, no browser or password flows, master {@code admin} role.
 */
public record ServiceAccount(String clientId, String clientSecret, String clientUuid) {

    public static final String AUTH_REALM = "master";

    private static final SecureRandom RANDOM = new SecureRandom();

    public static ServiceAccount provision(Keycloak bootstrapAdmin) {
        RealmResource master = bootstrapAdmin.realm(AUTH_REALM);
        ClientRepresentation client = new ClientRepresentation();
        client.setClientId("equivalence-" + hex(4));
        client.setSecret(hex(24));
        client.setPublicClient(false);
        client.setServiceAccountsEnabled(true);
        client.setStandardFlowEnabled(false);
        client.setDirectAccessGrantsEnabled(false);
        String uuid = CreatedResponseUtil.getCreatedId(master.clients().create(client));
        UserRepresentation user = master.clients().get(uuid).getServiceAccountUser();
        RoleRepresentation admin = master.roles().get("admin").toRepresentation();
        master.users().get(user.getId()).roles().realmLevel().add(List.of(admin));
        return new ServiceAccount(client.getClientId(), client.getSecret(), uuid);
    }

    /** Removes the client and with it the service-account user. */
    public void delete(Keycloak bootstrapAdmin) {
        bootstrapAdmin.realm(AUTH_REALM).clients().get(clientUuid).remove();
    }

    @Override
    public String toString() {
        return "ServiceAccount[" + clientId + "]";
    }

    private static String hex(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }
}
