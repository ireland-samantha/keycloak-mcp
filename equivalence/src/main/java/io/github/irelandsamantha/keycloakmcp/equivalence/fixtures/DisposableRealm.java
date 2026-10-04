package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import jakarta.ws.rs.NotFoundException;
import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.resource.RealmResource;
import org.keycloak.representations.idm.RealmRepresentation;

import java.util.function.Consumer;

/** A bare, enabled realm created for one check and deleted when closed. */
public final class DisposableRealm implements AutoCloseable {

    private final Keycloak admin;
    private final String name;

    private DisposableRealm(Keycloak admin, String name) {
        this.admin = admin;
        this.name = name;
    }

    /** Creates realm {@code name}; {@code settings} may adjust its representation first. */
    public static DisposableRealm create(Keycloak admin, String name, Consumer<RealmRepresentation> settings) {
        RealmRepresentation realm = new RealmRepresentation();
        realm.setRealm(name);
        realm.setEnabled(true);
        settings.accept(realm);
        admin.realms().create(realm);
        return new DisposableRealm(admin, name);
    }

    public String name() {
        return name;
    }

    /** The realm through the admin client that created it. */
    public RealmResource resource() {
        return admin.realm(name);
    }

    @Override
    public void close() {
        try {
            resource().remove();
        } catch (NotFoundException alreadyDeleted) {
            // an operation under test may have removed it
        }
    }
}
