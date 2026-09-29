package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;

import java.util.List;
import java.util.function.Function;

import static io.github.irelandsamantha.keycloakmcp.equivalence.mutations.NaturalKeys.clientRole;
import static io.github.irelandsamantha.keycloakmcp.equivalence.mutations.NaturalKeys.role;

/**
 * Realm roles, addressed by name ({@code /roles/{role-name}}) and by id ({@code /roles-by-id/{role-id}}): create,
 * update, rename, delete, and composites. Every twin starts with the roles {@code writer} (with a description and an
 * attribute), {@code reader} and {@code auditor}, and a client role to use as a composite. Server sources are cited
 * relative to {@code services/src/main/java/org/keycloak/services/resources/admin/}.
 */
public final class RealmRolesFamily implements MutationFamily {

    private static final String WRITER = "writer";
    private static final String READER = "reader";
    private static final String AUDITOR = "auditor";
    private static final String CLIENT = "family-client";
    private static final String CLIENT_ROLE = "client-reader";

    private static final String BY_NAME = "/admin/realms/{realm}/roles/{role-name}";
    private static final String BY_ID = "/admin/realms/{realm}/roles-by-id/{role-id}";

    /** Adding a composite a role already has, or removing one it lacks, changes nothing; the inverse would. */
    private static final String ASSOCIATION = "a request that finds the composites already as it asks changes nothing,"
            + " yet its inverse would still change them (RoleResource.java:123-141, 157-174)";

    /**
     * Paged, because only the paged query orders roles by name (RoleContainerResource.java:140-143,
     * model/jpa/src/main/java/org/keycloak/models/jpa/entities/RoleEntity.java:56); the unpaged list comes from a
     * cached set (model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/entities/RoleListQuery.java:13).
     */
    private static final Readback ROLES = Readback.of("GET /admin/realms/{realm}/roles", r -> CaseArgs.path(r.realm())
            .withQuery("briefRepresentation", "false").withQuery("first", "0").withQuery("max", "1000"));

    @Override
    public String name() {
        return "realm-roles";
    }

    @Override
    public void seed(CaseContext realm) {
        realm.create("roles", Json.read("""
                {"name": "writer", "description": "seeded", "attributes": {"tier": ["1"]}}"""));
        realm.create("roles", Json.read("""
                {"name": "reader"}"""));
        realm.create("roles", Json.read("""
                {"name": "auditor"}"""));
        String clientId = realm.create("clients", Json.read("""
                {"clientId": "family-client", "publicClient": true, "standardFlowEnabled": false}"""));
        realm.create("clients/" + clientId + "/roles", Json.read("""
                {"name": "client-reader"}"""));
    }

    @Override
    public List<MutationCase> cases() {
        return List.of(
                MutationCase.of("POST /admin/realms/{realm}/roles", "create a role")
                        .args(r -> CaseArgs.path(r.realm()).withBody(Json.read("""
                                {"name": "editor", "description": "created", "attributes": {"tier": ["2"]}}""")))
                        .compensatedBy(r -> new CaseRequest("DELETE " + BY_NAME, CaseArgs.path(r.realm(), "editor")))
                        .readback(ROLES)
                        .reversible("the role is created under the name in the body, and deleting that name undoes it"
                                + " (RoleContainerResource.java:170-174)")
                        .build(),
                MutationCase.of("PUT " + BY_NAME, "replace description and attributes")
                        .args(r -> byName(r, WRITER).withBody(changed(r, WRITER)))
                        .compensatedBy(r -> new CaseRequest("PUT " + BY_NAME, byName(r, WRITER).withBody(current(r, WRITER))))
                        .readback(ROLES)
                        .reversible("PUT of the representation read before restores description and attributes under"
                                + " the same name (RoleResource.java:65-121)")
                        .build(),
                MutationCase.of("PUT " + BY_NAME, "rename by name")
                        .args(r -> byName(r, WRITER).withBody(renamed(r, WRITER)))
                        .compensatedBy(r -> new CaseRequest("PUT " + BY_NAME, byName(r, WRITER).withBody(current(r, WRITER))))
                        .readback(ROLES)
                        .readback(roleById(WRITER))
                        .irreversible("the name is the path key: once renamed, /roles/writer no longer addresses the"
                                + " role (RoleContainerResource.java:338-343, RoleResource.java:71-73), so the only"
                                + " compensation keycloak-mcp accepts for a PUT, one to the same path, cannot reach it")
                        .requires("WF-06", "classification E6")
                        .build(),
                MutationCase.of("DELETE " + BY_NAME, "delete a role by name")
                        .args(r -> byName(r, AUDITOR))
                        .compensatedBy(RealmRolesFamily::recreateAuditor)
                        .readback(ROLES)
                        .irreversible("the role is gone with every mapping and composite that used it; a re-created"
                                + " one has a new id (RoleContainerResource.java:293-317)")
                        .build(),
                MutationCase.of("POST " + BY_NAME + "/composites", "add composites by name")
                        .args(r -> byName(r, WRITER).withBody(composites(r)))
                        .compensatedBy(r -> new CaseRequest("DELETE " + BY_NAME + "/composites",
                                byName(r, WRITER).withBody(composites(r))))
                        .readback(ROLES)
                        .readback(compositesOf(WRITER))
                        .irreversible(ASSOCIATION)
                        .build(),
                MutationCase.of("DELETE " + BY_NAME + "/composites", "remove composites by name")
                        .setup(RealmRolesFamily::writerComposites)
                        .args(r -> byName(r, WRITER).withBody(composites(r)))
                        .compensatedBy(r -> new CaseRequest("POST " + BY_NAME + "/composites",
                                byName(r, WRITER).withBody(composites(r))))
                        .readback(ROLES)
                        .readback(compositesOf(WRITER))
                        .irreversible(ASSOCIATION)
                        .build(),
                MutationCase.of("PUT " + BY_ID, "replace description and attributes by id")
                        .args(r -> byId(r, WRITER).withBody(changed(r, WRITER)))
                        .compensatedBy(r -> new CaseRequest("PUT " + BY_ID, byId(r, WRITER).withBody(current(r, WRITER))))
                        .readback(roleById(WRITER))
                        .reversible("PUT of the representation read before restores description and attributes"
                                + " (RoleByIdResource.java:170-182)")
                        .build(),
                MutationCase.of("PUT " + BY_ID, "rename by id")
                        .args(r -> byId(r, WRITER).withBody(renamed(r, WRITER)))
                        .compensatedBy(r -> new CaseRequest("PUT " + BY_ID, byId(r, WRITER).withBody(current(r, WRITER))))
                        .readback(ROLES)
                        .readback(roleById(WRITER))
                        .reversible("the id stays the path key through a rename, so PUT of the representation read"
                                + " before restores the name (RoleByIdResource.java:170-182, RoleResource.java:71-73)")
                        .build(),
                MutationCase.of("DELETE " + BY_ID, "delete a role by id")
                        .args(r -> byId(r, AUDITOR))
                        .compensatedBy(RealmRolesFamily::recreateAuditor)
                        .readback(ROLES)
                        .irreversible("the role is gone with every mapping and composite that used it; a re-created"
                                + " one has a new id (RoleByIdResource.java:133-152)")
                        .build(),
                MutationCase.of("POST " + BY_ID + "/composites", "add composites by id")
                        .args(r -> byId(r, WRITER).withBody(composites(r)))
                        .compensatedBy(r -> new CaseRequest("DELETE " + BY_ID + "/composites",
                                byId(r, WRITER).withBody(composites(r))))
                        .readback(ROLES)
                        .readback(compositesOf(WRITER))
                        .irreversible(ASSOCIATION)
                        .build(),
                MutationCase.of("DELETE " + BY_ID + "/composites", "remove composites by id")
                        .setup(RealmRolesFamily::writerComposites)
                        .args(r -> byId(r, WRITER).withBody(composites(r)))
                        .compensatedBy(r -> new CaseRequest("POST " + BY_ID + "/composites",
                                byId(r, WRITER).withBody(composites(r))))
                        .readback(ROLES)
                        .readback(compositesOf(WRITER))
                        .irreversible(ASSOCIATION)
                        .build());
    }

    private static CaseArgs byName(CaseContext realm, String role) {
        return CaseArgs.path(realm.realm(), role);
    }

    private static CaseArgs byId(CaseContext realm, String role) {
        return CaseArgs.path(realm.realm(), realm.id(role(role)));
    }

    private static Readback roleById(String role) {
        return Readback.of("GET " + BY_ID, r -> byId(r, role));
    }

    private static Readback compositesOf(String role) {
        return Readback.unordered("GET " + BY_NAME + "/composites", r -> byName(r, role),
                "the child roles are queried without an order (model/jpa/src/main/java/org/keycloak/models/jpa/"
                        + "entities/RoleEntity.java:63)");
    }

    private static JsonNode current(CaseContext realm, String role) {
        return realm.get("roles-by-id/" + realm.id(role(role)));
    }

    private static JsonNode changed(CaseContext realm, String role) {
        return edited(realm, role, rep -> rep.put("description", "updated").set("attributes", Json.read("""
                {"tier": ["3"], "added": ["yes"]}""")));
    }

    private static JsonNode renamed(CaseContext realm, String role) {
        return edited(realm, role, rep -> rep.put("name", role + "-renamed"));
    }

    private static JsonNode edited(CaseContext realm, String role, Function<ObjectNode, JsonNode> edit) {
        return edit.apply((ObjectNode) current(realm, role));
    }

    /** {@code reader} and the client role, as the composites endpoints take them. */
    private static JsonNode composites(CaseContext realm) {
        return Json.read("""
                [{"id": "%s", "name": "%s"}, {"id": "%s", "name": "%s"}]""".formatted(realm.id(role(READER)), READER,
                realm.id(clientRole(CLIENT, CLIENT_ROLE)), CLIENT_ROLE));
    }

    /** The undo a client would offer for deleting {@code auditor}: creating a role of that name again. */
    private static CaseRequest recreateAuditor(CaseContext realm) {
        return new CaseRequest("POST /admin/realms/{realm}/roles", CaseArgs.path(realm.realm()).withBody(Json.read("""
                {"name": "auditor"}""")));
    }

    private static void writerComposites(CaseContext realm) {
        realm.send("POST", "roles-by-id/" + realm.id(role(WRITER)) + "/composites", composites(realm));
    }
}
