package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.resource.GroupResource;
import org.keycloak.representations.idm.GroupRepresentation;
import org.keycloak.representations.idm.RoleRepresentation;

import java.util.List;
import java.util.Map;

/** Realm roles, and a group with a subgroup, attributes, realm and client role mappings, set as default group. */
final class RoleAndGroupSeeding {

    private RoleAndGroupSeeding() {
    }

    /** Before the clients: their roles and scope mappings refer to these. */
    static void realmRoles(Seeding s) {
        s.run("realm roles", () -> {
            s.realm.roles().create(role(RealmSeeder.CHILD_ROLE));
            s.realm.roles().create(role(RealmSeeder.ROLE));
        });
        s.step(SeededRealm.ROLE_ID, () -> s.realm.roles().get(RealmSeeder.ROLE).toRepresentation().getId());
    }

    /** After the clients: groups map client roles. */
    static void groups(Seeding s) {
        s.step(SeededRealm.GROUP_ID, () -> Seeding.created(s.realm.groups().add(group(RealmSeeder.GROUP))));
        s.step(SeededRealm.SUB_GROUP_ID, () -> Seeding.created(s.realm.groups().group(s.id(SeededRealm.GROUP_ID))
                .subGroup(group(RealmSeeder.SUB_GROUP))));
        s.run("group role mappings", () -> mapRoles(s, s.realm.groups().group(s.id(SeededRealm.GROUP_ID))));
        s.run("default group", () -> s.realm.addDefaultGroup(s.id(SeededRealm.GROUP_ID)));
    }

    static RoleRepresentation role(String name) {
        RoleRepresentation role = new RoleRepresentation();
        role.setName(name);
        return role;
    }

    static GroupRepresentation group(String name) {
        GroupRepresentation g = new GroupRepresentation();
        g.setName(name);
        g.setAttributes(Map.of("seed-attribute", List.of(name)));
        return g;
    }

    private static void mapRoles(Seeding s, GroupResource group) {
        String client = s.id(SeededRealm.CLIENT_ID);
        List<RoleRepresentation> realmRole = List.of(s.realm.roles().get(RealmSeeder.ROLE).toRepresentation());
        group.roles().realmLevel().add(realmRole);
        group.roles().clientLevel(client).add(List.of(s.realm.clients().get(client).roles().get(RealmSeeder.ROLE).toRepresentation()));
    }
}
