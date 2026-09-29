package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import jakarta.ws.rs.core.Response;
import org.keycloak.admin.client.resource.AuthorizationResource;
import org.keycloak.representations.idm.authorization.AbstractPolicyRepresentation;
import org.keycloak.representations.idm.authorization.AggregatePolicyRepresentation;
import org.keycloak.representations.idm.authorization.ClientPolicyRepresentation;
import org.keycloak.representations.idm.authorization.ClientScopePolicyRepresentation;
import org.keycloak.representations.idm.authorization.GroupPolicyRepresentation;
import org.keycloak.representations.idm.authorization.RegexPolicyRepresentation;
import org.keycloak.representations.idm.authorization.ResourcePermissionRepresentation;
import org.keycloak.representations.idm.authorization.ResourceRepresentation;
import org.keycloak.representations.idm.authorization.RolePolicyRepresentation;
import org.keycloak.representations.idm.authorization.ScopePermissionRepresentation;
import org.keycloak.representations.idm.authorization.ScopeRepresentation;
import org.keycloak.representations.idm.authorization.TimePolicyRepresentation;
import org.keycloak.representations.idm.authorization.UserPolicyRepresentation;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiFunction;
import java.util.function.Supplier;

/**
 * The confidential client's resource server: a scope, a resource carrying it, a policy of every type the admin
 * client can create except JavaScript (JS policies only come from deployed provider jars,
 * {@code JSPolicyProviderFactory.java:62-63,131-134}), and a resource and a scope permission.
 *
 * <p>Every typed path gets its own target, so a route probe that deletes one type cannot remove another's; the
 * untyped {@code policy/{id}} paths get a scope permission of their own, whose associated policies, resources and
 * scopes are all non-empty.
 */
final class AuthorizationSeeding {

    private static final String GENERIC_POLICY = "p-generic-dependency";

    private AuthorizationSeeding() {
    }

    static void seed(Seeding s) {
        Supplier<AuthorizationResource> authz = () -> s.realm.clients().get(s.id(SeededRealm.CLIENT_ID)).authorization();
        s.step(SeededRealm.SCOPE_ID, () -> {
            Seeding.ensure2xx(authz.get().scopes().create(new ScopeRepresentation(RealmSeeder.SCOPE_NAME)));
            return authz.get().scopes().findByName(RealmSeeder.SCOPE_NAME).getId();
        });
        // Clients created over REST get no "Default Resource" on HEAD; create one.
        s.step(SeededRealm.RESOURCE_ID, () -> {
            ResourceRepresentation resource = new ResourceRepresentation("seed-resource", RealmSeeder.SCOPE_NAME);
            resource.setType("urn:seed:resource");
            resource.setUris(Set.of("/seed/*"));
            resource.setAttributes(Map.of("seed-attribute", List.of("seeded")));
            try (Response resp = authz.get().resources().create(resource)) {
                if (resp.getStatus() != 201) {
                    throw new IllegalStateException("HTTP " + resp.getStatus() + " " + resp.readEntity(String.class));
                }
                return resp.readEntity(ResourceRepresentation.class).getId();
            }
        });
        policies(s, authz);
        permissions(s, authz);
    }

    private static void policies(Seeding s, Supplier<AuthorizationResource> authz) {
        entry(s, SeededRealm.policy("user"), authz, RealmSeeder.USER_POLICY, () -> {
            UserPolicyRepresentation p = new UserPolicyRepresentation();
            p.addUser(s.id(SeededRealm.USER_ID));
            return p;
        }, (a, rep) -> a.policies().user().create((UserPolicyRepresentation) rep));
        entry(s, SeededRealm.policy("role"), authz, "p-role", () -> {
            RolePolicyRepresentation p = new RolePolicyRepresentation();
            p.addRole(RealmSeeder.ROLE);
            return p;
        }, (a, rep) -> a.policies().role().create((RolePolicyRepresentation) rep));
        entry(s, SeededRealm.policy("group"), authz, "p-group", () -> {
            GroupPolicyRepresentation p = new GroupPolicyRepresentation();
            p.addGroup(s.id(SeededRealm.GROUP_ID), false);
            return p;
        }, (a, rep) -> a.policies().group().create((GroupPolicyRepresentation) rep));
        entry(s, SeededRealm.policy("time"), authz, "p-time", () -> {
            TimePolicyRepresentation p = new TimePolicyRepresentation();
            p.setNotBefore("2020-01-01 00:00:00");
            return p;
        }, (a, rep) -> a.policies().time().create((TimePolicyRepresentation) rep));
        entry(s, SeededRealm.policy("client"), authz, "p-client", () -> {
            ClientPolicyRepresentation p = new ClientPolicyRepresentation();
            p.addClient(s.id(SeededRealm.CLIENT_ID));
            return p;
        }, (a, rep) -> a.policies().client().create((ClientPolicyRepresentation) rep));
        entry(s, SeededRealm.policy("client-scope"), authz, "p-client-scope", () -> {
            ClientScopePolicyRepresentation p = new ClientScopePolicyRepresentation();
            p.addClientScope(s.id(SeededRealm.CLIENT_SCOPE_ID));
            return p;
        }, (a, rep) -> a.policies().clientScope().create((ClientScopePolicyRepresentation) rep));
        entry(s, SeededRealm.policy("regex"), authz, "p-regex", () -> {
            RegexPolicyRepresentation p = new RegexPolicyRepresentation();
            p.setTargetClaim("preferred_username");
            p.setPattern("^seed-.*$");
            return p;
        }, (a, rep) -> a.policies().regex().create((RegexPolicyRepresentation) rep));
        entry(s, SeededRealm.policy("aggregate"), authz, "p-aggregate", () -> {
            AggregatePolicyRepresentation p = new AggregatePolicyRepresentation();
            p.addPolicy(RealmSeeder.USER_POLICY);
            return p;
        }, (a, rep) -> a.policies().aggregate().create((AggregatePolicyRepresentation) rep));
    }

    private static void permissions(Seeding s, Supplier<AuthorizationResource> authz) {
        entry(s, SeededRealm.permission("resource"), authz, "perm-resource", () -> {
            ResourcePermissionRepresentation p = new ResourcePermissionRepresentation();
            p.addResource(s.id(SeededRealm.RESOURCE_ID));
            p.addPolicy(RealmSeeder.USER_POLICY);
            return p;
        }, (a, rep) -> a.permissions().resource().create((ResourcePermissionRepresentation) rep));
        entry(s, SeededRealm.permission("scope"), authz, "perm-scope", () -> scopePermission(s, RealmSeeder.USER_POLICY),
                (a, rep) -> a.permissions().scope().create((ScopePermissionRepresentation) rep));
        // A permission whose last associated policy is deleted is deleted with it (AuthorizationProvider.java:
        // 374-378), so the untyped target depends on a policy no typed path addresses.
        entry(s, SeededRealm.policy("generic-dependency"), authz, GENERIC_POLICY, () -> {
            UserPolicyRepresentation p = new UserPolicyRepresentation();
            p.addUser(s.id(SeededRealm.USER_ID));
            return p;
        }, (a, rep) -> a.policies().user().create((UserPolicyRepresentation) rep));
        entry(s, SeededRealm.policy("generic"), authz, "perm-generic", () -> scopePermission(s, GENERIC_POLICY),
                (a, rep) -> a.permissions().scope().create((ScopePermissionRepresentation) rep));
    }

    private static ScopePermissionRepresentation scopePermission(Seeding s, String policy) {
        ScopePermissionRepresentation p = new ScopePermissionRepresentation();
        p.addScope(RealmSeeder.SCOPE_NAME);
        p.addResource(s.id(SeededRealm.RESOURCE_ID));
        p.addPolicy(policy);
        return p;
    }

    private static void entry(Seeding s, String key, Supplier<AuthorizationResource> authz, String name,
                              Supplier<AbstractPolicyRepresentation> rep,
                              BiFunction<AuthorizationResource, AbstractPolicyRepresentation, Response> create) {
        s.step(key, () -> {
            AbstractPolicyRepresentation p = rep.get();
            p.setName(name);
            AuthorizationResource a = authz.get();
            Seeding.ensure2xx(create.apply(a, p));
            return a.policies().findByName(name).getId();
        });
    }
}
