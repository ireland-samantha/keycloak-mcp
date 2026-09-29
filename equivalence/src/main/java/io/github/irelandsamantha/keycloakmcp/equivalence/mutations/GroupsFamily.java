package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;

import java.util.List;

import static io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.LOCATION_ID;
import static io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.RESPONSE_ID;
import static io.github.irelandsamantha.keycloakmcp.equivalence.mutations.NaturalKeys.client;
import static io.github.irelandsamantha.keycloakmcp.equivalence.mutations.NaturalKeys.clientRole;
import static io.github.irelandsamantha.keycloakmcp.equivalence.mutations.NaturalKeys.group;
import static io.github.irelandsamantha.keycloakmcp.equivalence.mutations.NaturalKeys.role;

/**
 * Groups: top-level and child creates, moves, updates and deletes, default groups, and realm and client role
 * mappings. Every twin starts with {@code /alpha} (holding {@code /alpha/beta}) and {@code /gamma}, plus a realm
 * role and a client role to map. Server sources are cited relative to
 * {@code services/src/main/java/org/keycloak/services/resources/admin/}.
 */
public final class GroupsFamily implements MutationFamily {

    private static final String ALPHA = "/alpha";
    private static final String BETA = "/alpha/beta";
    private static final String GAMMA = "/gamma";
    private static final String ROLE = "family-role";
    private static final String CLIENT = "family-client";
    private static final String CLIENT_ROLE = "family-client-role";

    private static final String CREATE = "POST /admin/realms/{realm}/groups";
    private static final String CREATE_CHILD = "POST /admin/realms/{realm}/groups/{group-id}/children";
    private static final String UPDATE = "PUT /admin/realms/{realm}/groups/{group-id}";
    private static final String DELETE = "DELETE /admin/realms/{realm}/groups/{group-id}";
    private static final String REALM_MAPPINGS = "/admin/realms/{realm}/groups/{group-id}/role-mappings/realm";
    private static final String CLIENT_MAPPINGS = "/admin/realms/{realm}/groups/{group-id}/role-mappings/clients/{client-id}";
    private static final String DEFAULT_GROUP = "/admin/realms/{realm}/default-groups/{groupId}";

    /** Mapping a role, or making a group default, again changes nothing, so the inverse can undo more than was done. */
    private static final String ASSOCIATION = "when the association already held, the inverse request would remove"
            + " one that existed before the operation";

    private static final Readback TOP_LEVEL = Readback.of("GET /admin/realms/{realm}/groups",
            r -> CaseArgs.path(r.realm()).withQuery("briefRepresentation", "false"));
    private static final Readback DEFAULT_GROUPS = Readback.of("GET /admin/realms/{realm}/default-groups",
            r -> CaseArgs.path(r.realm()));

    @Override
    public String name() {
        return "groups";
    }

    @Override
    public void seed(CaseContext realm) {
        realm.create("roles", Json.read("""
                {"name": "family-role"}"""));
        String clientId = realm.create("clients", Json.read("""
                {"clientId": "family-client", "publicClient": true, "standardFlowEnabled": false}"""));
        realm.create("clients/" + clientId + "/roles", Json.read("""
                {"name": "family-client-role"}"""));
        String alpha = realm.create("groups", Json.read("""
                {"name": "alpha", "description": "seeded", "attributes": {"origin": ["seed"]}}"""));
        realm.create("groups/" + alpha + "/children", Json.read("""
                {"name": "beta", "attributes": {"origin": ["seed"]}}"""));
        realm.create("groups", Json.read("""
                {"name": "gamma"}"""));
    }

    @Override
    public List<MutationCase> cases() {
        return List.of(
                MutationCase.of(CREATE, "create a top-level group")
                        .args(r -> CaseArgs.path(r.realm()).withBody(Json.read("""
                                {"name": "delta", "description": "created", "attributes": {"origin": ["case"]}}""")))
                        .compensatedBy(r -> new CaseRequest(DELETE, CaseArgs.path(r.realm(), LOCATION_ID)))
                        .readback(TOP_LEVEL)
                        .reversible("deleting the group by the id its 201 Location names undoes the create"
                                + " (GroupsResource.java:226-235)")
                        .build(),
                MutationCase.of(CREATE, "refuse a top-level name that is taken")
                        .args(r -> CaseArgs.path(r.realm()).withBody(Json.read("""
                                {"name": "gamma"}""")))
                        .compensatedBy(r -> new CaseRequest(DELETE, CaseArgs.path(r.realm(), LOCATION_ID)))
                        .readback(TOP_LEVEL)
                        .reversible("the server answers 409 and creates nothing (GroupsResource.java:236-237)")
                        .build(),
                MutationCase.of(CREATE, "move a subgroup to the top level")
                        .args(r -> CaseArgs.path(r.realm()).withBody(Json.read("""
                                {"id": "%s", "name": "beta"}""".formatted(r.id(group(BETA))))))
                        .compensatedBy(r -> new CaseRequest(DELETE, CaseArgs.path(r.realm(), LOCATION_ID)))
                        .readback(TOP_LEVEL)
                        .readback(childrenOf(ALPHA))
                        .irreversible("a body with an id moves that existing group to the top level and answers 204"
                                + " without a Location (GroupsResource.java:214-225): the move is not a create, and no"
                                + " DELETE puts the group back under its parent")
                        .requires("body-aware classification of POST .../groups (F3 counterexample)")
                        .build(),
                MutationCase.of(UPDATE, "replace description and attributes")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(Json.read("""
                                {"name": "alpha", "description": "updated", "attributes": {"added": ["yes"]}}""")))
                        .compensatedBy(r -> new CaseRequest(UPDATE, CaseArgs.path(r.realm(), r.id(group(ALPHA)))
                                .withBody(r.get("groups/" + r.id(group(ALPHA))))))
                        .readback(groupById(ALPHA))
                        .reversible("PUT of the representation read before restores name, description and attributes"
                                + " (GroupResource.java:291-319)")
                        .build(),
                MutationCase.of(UPDATE, "rename by id")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(renamed(r, ALPHA, "alpha-renamed")))
                        .compensatedBy(r -> new CaseRequest(UPDATE, CaseArgs.path(r.realm(), r.id(group(ALPHA)))
                                .withBody(r.get("groups/" + r.id(group(ALPHA))))))
                        .readback(groupById(ALPHA))
                        .readback(TOP_LEVEL)
                        .reversible("the id stays the path key through a rename, so PUT of the representation read"
                                + " before restores the name (GroupResource.java:291-304)")
                        .build(),
                MutationCase.of(DELETE, "delete a group")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(GAMMA))))
                        .readback(TOP_LEVEL)
                        .readback(groupById(GAMMA))
                        .irreversible("the group is gone with its memberships and role mappings; a re-created one has"
                                + " a new id (GroupResource.java:179-187)")
                        .build(),
                MutationCase.of(CREATE_CHILD, "create a subgroup")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(Json.read("""
                                {"name": "epsilon", "attributes": {"origin": ["case"]}}""")))
                        .compensatedBy(r -> new CaseRequest(DELETE, CaseArgs.path(r.realm(), RESPONSE_ID)))
                        .readback(childrenOf(ALPHA))
                        .reversible("deleting the child by the id in the 201 answer undoes the create"
                                + " (GroupResource.java:267-285)")
                        .build(),
                MutationCase.of(CREATE_CHILD, "move a group under another")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(Json.read("""
                                {"id": "%s", "name": "gamma"}""".formatted(r.id(group(GAMMA))))))
                        .compensatedBy(r -> new CaseRequest(DELETE, CaseArgs.path(r.realm(), RESPONSE_ID)))
                        .readback(TOP_LEVEL)
                        .readback(childrenOf(ALPHA))
                        .irreversible("a body with an id moves that existing group under this one"
                                + " (GroupResource.java:257-266); deleting the id the answer names would destroy the"
                                + " moved group instead of moving it back")
                        .build(),
                MutationCase.of("PUT " + DEFAULT_GROUP, "make a group default")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(GAMMA))))
                        .readback(DEFAULT_GROUPS)
                        .irreversible(ASSOCIATION + " (RealmAdminResource.java:1259-1270)")
                        .build(),
                MutationCase.of("DELETE " + DEFAULT_GROUP, "stop a group being default")
                        .setup(r -> r.send("PUT", "default-groups/" + r.id(group(GAMMA)), null))
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(GAMMA))))
                        .readback(DEFAULT_GROUPS)
                        .irreversible(ASSOCIATION + " (RealmAdminResource.java:1282-1293)")
                        .build(),
                MutationCase.of("POST " + REALM_MAPPINGS, "map a realm role")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(realmRoles(r)))
                        .compensatedBy(r -> new CaseRequest("DELETE " + REALM_MAPPINGS,
                                CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(realmRoles(r))))
                        .readback(realmMappingsOf(ALPHA))
                        .irreversible(ASSOCIATION + " (RoleMapperResource.java:278-303)")
                        .build(),
                MutationCase.of("DELETE " + REALM_MAPPINGS, "unmap a realm role")
                        .setup(r -> r.send("POST", "groups/" + r.id(group(ALPHA)) + "/role-mappings/realm", realmRoles(r)))
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA))).withBody(realmRoles(r)))
                        .readback(realmMappingsOf(ALPHA))
                        .irreversible(ASSOCIATION + " (RoleMapperResource.java:322-357)")
                        .build(),
                MutationCase.of("POST " + CLIENT_MAPPINGS, "map a client role")
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA)), r.id(client(CLIENT))).withBody(clientRoles(r)))
                        .compensatedBy(r -> new CaseRequest("DELETE " + CLIENT_MAPPINGS,
                                CaseArgs.path(r.realm(), r.id(group(ALPHA)), r.id(client(CLIENT))).withBody(clientRoles(r))))
                        .readback(clientMappingsOf(ALPHA))
                        .irreversible(ASSOCIATION + " (ClientRoleMappingsResource.java:176-200)")
                        .build(),
                MutationCase.of("DELETE " + CLIENT_MAPPINGS, "unmap a client role")
                        .setup(r -> r.send("POST", "groups/" + r.id(group(ALPHA)) + "/role-mappings/clients/"
                                + r.id(client(CLIENT)), clientRoles(r)))
                        .args(r -> CaseArgs.path(r.realm(), r.id(group(ALPHA)), r.id(client(CLIENT))).withBody(clientRoles(r)))
                        .readback(clientMappingsOf(ALPHA))
                        .irreversible(ASSOCIATION + " (ClientRoleMappingsResource.java:211-243)")
                        .build());
    }

    private static Readback groupById(String path) {
        return Readback.of("GET /admin/realms/{realm}/groups/{group-id}", r -> CaseArgs.path(r.realm(), r.id(group(path))));
    }

    private static Readback childrenOf(String path) {
        return Readback.of("GET /admin/realms/{realm}/groups/{group-id}/children", r -> CaseArgs.path(r.realm(),
                r.id(group(path))).withQuery("briefRepresentation", "false"));
    }

    private static Readback realmMappingsOf(String path) {
        return Readback.of("GET " + REALM_MAPPINGS, r -> CaseArgs.path(r.realm(), r.id(group(path))));
    }

    private static Readback clientMappingsOf(String path) {
        return Readback.of("GET " + CLIENT_MAPPINGS, r -> CaseArgs.path(r.realm(), r.id(group(path)),
                r.id(client(CLIENT))));
    }

    /** The group's current representation under a new name. */
    private static JsonNode renamed(CaseContext realm, String path, String name) {
        return ((ObjectNode) realm.get("groups/" + realm.id(group(path)))).put("name", name);
    }

    private static JsonNode realmRoles(CaseContext realm) {
        return Json.read("""
                [{"id": "%s", "name": "%s"}]""".formatted(realm.id(role(ROLE)), ROLE));
    }

    private static JsonNode clientRoles(CaseContext realm) {
        return Json.read("""
                [{"id": "%s", "name": "%s"}]""".formatted(realm.id(clientRole(CLIENT, CLIENT_ROLE)), CLIENT_ROLE));
    }
}
