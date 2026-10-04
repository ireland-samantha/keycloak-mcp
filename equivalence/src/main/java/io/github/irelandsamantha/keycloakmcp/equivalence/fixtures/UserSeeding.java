package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.resource.UserResource;
import org.keycloak.representations.idm.ClientScopeRepresentation;
import org.keycloak.representations.idm.CredentialRepresentation;
import org.keycloak.representations.idm.FederatedIdentityRepresentation;
import org.keycloak.representations.idm.PartialImportRepresentation;
import org.keycloak.representations.idm.UserConsentRepresentation;
import org.keycloak.representations.idm.UserRepresentation;
import org.keycloak.representations.idm.oid4vc.UserVerifiableCredentialRepresentation;

import java.util.List;
import java.util.Map;

/**
 * The seeded user: a password, an unmanaged attribute, a link to the seeded identity provider, a consent to the
 * confidential client, membership of the seeded group, its realm and client role, and a verifiable credential.
 */
final class UserSeeding {

    private static final String VC_SCOPE = "seed-vc";

    private UserSeeding() {
    }

    static void seed(Seeding s) {
        // Consents cannot be granted through the admin API; a partial import creates the user through the
        // export/import path, which stores them (DefaultExportImportManager.java:1050-1055), along with the
        // password and the federated identity.
        s.step(SeededRealm.USER_ID, () -> {
            PartialImportRepresentation users = new PartialImportRepresentation();
            users.setUsers(List.of(user(s)));
            Seeding.ensure2xx(s.realm.partialImport(users));
            return s.realm.users().search(RealmSeeder.USER, true).getFirst().getId();
        });
        s.run("user memberships", () -> {
            UserResource user = s.realm.users().get(s.id(SeededRealm.USER_ID));
            String client = s.id(SeededRealm.CLIENT_ID);
            user.joinGroup(s.id(SeededRealm.GROUP_ID));
            // Import adds the user without the realm's default roles (DefaultExportImportManager.java:1024), and
            // offline_access, needed for the offline session, is one of them.
            user.roles().realmLevel().add(List.of(s.realm.roles().get(RealmSeeder.ROLE).toRepresentation(),
                    s.realm.roles().get("default-roles-" + s.realmName).toRepresentation()));
            user.roles().clientLevel(client).add(List.of(s.realm.clients().get(client).roles().get(RealmSeeder.ROLE).toRepresentation()));
        });
        // Needs the oid4vc-vci feature (UserVerifiableCredentialResource.java:336-343); logged when it is off.
        s.run("verifiable credential", () -> {
            ClientScopeRepresentation scope = new ClientScopeRepresentation();
            scope.setName(VC_SCOPE);
            scope.setProtocol("oid4vc");
            Seeding.created(s.realm.clientScopes().create(scope));
            UserVerifiableCredentialRepresentation credential = new UserVerifiableCredentialRepresentation();
            credential.setCredentialScopeName(VC_SCOPE);
            s.realm.users().get(s.id(SeededRealm.USER_ID)).verifiableCredentials().createCredential(credential);
        });
    }

    private static UserRepresentation user(Seeding s) {
        UserRepresentation u = new UserRepresentation();
        u.setUsername(RealmSeeder.USER);
        u.setEmail(RealmSeeder.USER + "@" + RealmSeeder.DOMAIN);
        u.setEmailVerified(true);
        // The default user profile requires both names; without them a login needs a profile update first.
        u.setFirstName("Seed");
        u.setLastName("User");
        u.setEnabled(true);
        u.setAttributes(Map.of("seed-unmanaged", List.of("seeded")));
        u.setCredentials(List.of(password(s.userPassword)));
        u.setFederatedIdentities(List.of(federatedIdentity()));
        u.setClientConsents(List.of(consent()));
        return u;
    }

    private static CredentialRepresentation password(String value) {
        CredentialRepresentation c = new CredentialRepresentation();
        c.setType(CredentialRepresentation.PASSWORD);
        c.setValue(value);
        c.setTemporary(false);
        return c;
    }

    private static FederatedIdentityRepresentation federatedIdentity() {
        FederatedIdentityRepresentation link = new FederatedIdentityRepresentation();
        link.setIdentityProvider(RealmSeeder.IDP_ALIAS);
        link.setUserId("seed-external-id");
        link.setUserName("seed-external");
        return link;
    }

    private static UserConsentRepresentation consent() {
        UserConsentRepresentation consent = new UserConsentRepresentation();
        consent.setClientId(RealmSeeder.CLIENT);
        consent.setGrantedClientScopes(List.of(RealmSeeder.SCOPE_NAME));
        return consent;
    }
}
