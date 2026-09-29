package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import jakarta.ws.rs.core.Response;
import org.keycloak.admin.client.CreatedResponseUtil;
import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.resource.AuthorizationResource;
import org.keycloak.admin.client.resource.RealmResource;
import org.keycloak.representations.idm.ClientRepresentation;
import org.keycloak.representations.idm.ClientScopeRepresentation;
import org.keycloak.representations.idm.GroupRepresentation;
import org.keycloak.representations.idm.IdentityProviderRepresentation;
import org.keycloak.representations.idm.OrganizationDomainRepresentation;
import org.keycloak.representations.idm.OrganizationRepresentation;
import org.keycloak.representations.idm.RealmRepresentation;
import org.keycloak.representations.idm.RoleRepresentation;
import org.keycloak.representations.idm.UserRepresentation;
import org.keycloak.representations.idm.authorization.AbstractPolicyRepresentation;
import org.keycloak.representations.idm.authorization.AggregatePolicyRepresentation;
import org.keycloak.representations.idm.authorization.ClientPolicyRepresentation;
import org.keycloak.representations.idm.authorization.GroupPolicyRepresentation;
import org.keycloak.representations.idm.authorization.ResourcePermissionRepresentation;
import org.keycloak.representations.idm.authorization.ResourceRepresentation;
import org.keycloak.representations.idm.authorization.RolePolicyRepresentation;
import org.keycloak.representations.idm.authorization.ScopePermissionRepresentation;
import org.keycloak.representations.idm.authorization.ScopeRepresentation;
import org.keycloak.representations.idm.authorization.TimePolicyRepresentation;
import org.keycloak.representations.idm.authorization.UserPolicyRepresentation;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Creates a disposable realm holding one entity of every kind the admin API addresses by id or name, so an
 * operation can be called with values that exist. Steps are best-effort: a failed step leaves its id unset and is
 * recorded in {@link SeededRealm#log()}, so a later check can explain a surprising response.
 */
public final class RealmSeeder {

    public static final String USER = "seed-user";
    public static final String ROLE = "seed-role";
    public static final String GROUP = "seed-group";
    public static final String SUB_GROUP = "seed-sub-group";
    public static final String IDP_ALIAS = "seed-idp";
    public static final String SCOPE_NAME = "seed-scope";
    /** Policy names; each typed policy gets its own so deleting one type cannot remove another's target. */
    public static final String USER_POLICY = "p-user";

    private final Keycloak admin;

    public RealmSeeder(Keycloak admin) {
        this.admin = admin;
    }

    /** Creates realm {@code name} and populates it. The caller owns the result and must close it. */
    public SeededRealm seed(String name) {
        RealmRepresentation realm = new RealmRepresentation();
        realm.setRealm(name);
        realm.setEnabled(true);
        realm.setOrganizationsEnabled(true);
        admin.realms().create(realm);
        Seeding s = new Seeding(admin.realm(name));
        s.populate();
        return new SeededRealm(admin, name, Map.copyOf(s.ids), List.copyOf(s.log));
    }

    /** Mutable state of one seeding run. */
    private static final class Seeding {
        private final RealmResource r;
        private final Map<String, String> ids = new LinkedHashMap<>();
        private final List<String> log = new ArrayList<>();

        Seeding(RealmResource r) {
            this.r = r;
        }

        void populate() {
            step(SeededRealm.REALM_ID, () -> r.toRepresentation().getId());
            step(SeededRealm.USER_ID, () -> created(r.users().create(user())));
            step(SeededRealm.ROLE_ID, () -> {
                r.roles().create(role());
                return r.roles().get(ROLE).toRepresentation().getId();
            });
            step(SeededRealm.GROUP_ID, () -> created(r.groups().add(group(GROUP))));
            step(SeededRealm.SUB_GROUP_ID, () -> created(r.groups().group(ids.get(SeededRealm.GROUP_ID)).subGroup(group(SUB_GROUP))));
            step(SeededRealm.CLIENT_SCOPE_ID, () -> {
                ClientScopeRepresentation cs = new ClientScopeRepresentation();
                cs.setName(SCOPE_NAME);
                cs.setProtocol("openid-connect");
                return created(r.clientScopes().create(cs));
            });
            step(SeededRealm.CLIENT_ID, () -> {
                ClientRepresentation c = new ClientRepresentation();
                c.setClientId("seed-authz");
                c.setPublicClient(false);
                c.setServiceAccountsEnabled(true);
                c.setAuthorizationServicesEnabled(true);
                return created(r.clients().create(c));
            });
            step(SeededRealm.CLIENT_ROLE, () -> {
                r.clients().get(ids.get(SeededRealm.CLIENT_ID)).roles().create(role());
                return ROLE;
            });
            step(SeededRealm.COMPONENT_ID, () -> r.components()
                    .query(ids.get(SeededRealm.REALM_ID), "org.keycloak.keys.KeyProvider").getFirst().getId());
            step(SeededRealm.EXECUTION_ID, () -> r.flows().getExecutions("browser").getFirst().getId());
            step(SeededRealm.IDP, () -> {
                try (Response resp = r.identityProviders().create(identityProvider())) {
                    ensure2xx(resp);
                }
                return IDP_ALIAS;
            });
            step(SeededRealm.ORG_ID, () -> created(r.organizations().create(organization())));
            step(SeededRealm.ORG_MEMBER, () -> {
                try (Response resp = r.organizations().get(ids.get(SeededRealm.ORG_ID)).members().addMember(ids.get(SeededRealm.USER_ID))) {
                    ensure2xx(resp);
                }
                return ids.get(SeededRealm.USER_ID);
            });
            populateAuthorization(r.clients().get(ids.getOrDefault(SeededRealm.CLIENT_ID, SeededRealm.MISSING)).authorization());
        }

        private void populateAuthorization(AuthorizationResource authz) {
            // Clients created over REST get no "Default Resource" on HEAD; create one.
            step(SeededRealm.RESOURCE_ID, () -> {
                try (Response resp = authz.resources().create(new ResourceRepresentation("seed-resource"))) {
                    ensure2xx(resp);
                    return resp.readEntity(ResourceRepresentation.class).getId();
                }
            });
            step(SeededRealm.SCOPE_ID, () -> {
                try (Response resp = authz.scopes().create(new ScopeRepresentation(SCOPE_NAME))) {
                    ensure2xx(resp);
                }
                return authz.scopes().findByName(SCOPE_NAME).getId();
            });
            policy(authz, "user", USER_POLICY, () -> {
                UserPolicyRepresentation p = new UserPolicyRepresentation();
                p.addUser(ids.get(SeededRealm.USER_ID));
                return p;
            }, rep -> authz.policies().user().create((UserPolicyRepresentation) rep));
            // Separate target for the untyped /policy/{id} operations, so typed deletes cannot remove it first.
            policy(authz, "generic", "p-generic", () -> {
                UserPolicyRepresentation p = new UserPolicyRepresentation();
                p.addUser(ids.get(SeededRealm.USER_ID));
                return p;
            }, rep -> authz.policies().user().create((UserPolicyRepresentation) rep));
            policy(authz, "role", "p-role", () -> {
                RolePolicyRepresentation p = new RolePolicyRepresentation();
                p.addRole(ROLE);
                return p;
            }, rep -> authz.policies().role().create((RolePolicyRepresentation) rep));
            policy(authz, "group", "p-group", () -> {
                GroupPolicyRepresentation p = new GroupPolicyRepresentation();
                p.addGroup(ids.get(SeededRealm.GROUP_ID), false);
                return p;
            }, rep -> authz.policies().group().create((GroupPolicyRepresentation) rep));
            policy(authz, "time", "p-time", () -> {
                TimePolicyRepresentation p = new TimePolicyRepresentation();
                p.setNotBefore("2020-01-01 00:00:00");
                return p;
            }, rep -> authz.policies().time().create((TimePolicyRepresentation) rep));
            policy(authz, "client", "p-client", () -> {
                ClientPolicyRepresentation p = new ClientPolicyRepresentation();
                p.addClient(ids.get(SeededRealm.CLIENT_ID));
                return p;
            }, rep -> authz.policies().client().create((ClientPolicyRepresentation) rep));
            policy(authz, "aggregate", "p-aggregate", () -> {
                AggregatePolicyRepresentation p = new AggregatePolicyRepresentation();
                p.addPolicy(USER_POLICY);
                return p;
            }, rep -> authz.policies().aggregate().create((AggregatePolicyRepresentation) rep));
            permission(authz, "resource", "perm-resource", () -> {
                ResourcePermissionRepresentation p = new ResourcePermissionRepresentation();
                p.addResource(ids.get(SeededRealm.RESOURCE_ID));
                p.addPolicy(USER_POLICY);
                return p;
            }, rep -> authz.permissions().resource().create((ResourcePermissionRepresentation) rep));
            permission(authz, "scope", "perm-scope", () -> {
                ScopePermissionRepresentation p = new ScopePermissionRepresentation();
                p.addScope(SCOPE_NAME);
                p.addPolicy(USER_POLICY);
                return p;
            }, rep -> authz.permissions().scope().create((ScopePermissionRepresentation) rep));
        }

        private void policy(AuthorizationResource authz, String type, String name, Supplier<AbstractPolicyRepresentation> rep,
                            Function<AbstractPolicyRepresentation, Response> create) {
            authorizationEntry(SeededRealm.policy(type), authz, name, rep, create);
        }

        private void permission(AuthorizationResource authz, String type, String name, Supplier<AbstractPolicyRepresentation> rep,
                                Function<AbstractPolicyRepresentation, Response> create) {
            authorizationEntry(SeededRealm.permission(type), authz, name, rep, create);
        }

        private void authorizationEntry(String key, AuthorizationResource authz, String name,
                                        Supplier<AbstractPolicyRepresentation> rep,
                                        Function<AbstractPolicyRepresentation, Response> create) {
            step(key, () -> {
                AbstractPolicyRepresentation p = rep.get();
                p.setName(name);
                try (Response resp = create.apply(p)) {
                    ensure2xx(resp);
                }
                return authz.policies().findByName(name).getId();
            });
        }

        private void step(String key, Supplier<String> action) {
            try {
                ids.put(key, action.get());
            } catch (RuntimeException e) {
                log.add(key + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }
    }

    private static String created(Response r) {
        try (r) {
            return CreatedResponseUtil.getCreatedId(r);
        }
    }

    private static void ensure2xx(Response r) {
        if (r.getStatus() / 100 != 2) {
            throw new IllegalStateException("HTTP " + r.getStatus() + " " + r.readEntity(String.class));
        }
    }

    private static UserRepresentation user() {
        UserRepresentation u = new UserRepresentation();
        u.setUsername(USER);
        u.setEmail(USER + "@seed.example");
        u.setEnabled(true);
        return u;
    }

    private static RoleRepresentation role() {
        RoleRepresentation role = new RoleRepresentation();
        role.setName(ROLE);
        return role;
    }

    private static GroupRepresentation group(String name) {
        GroupRepresentation g = new GroupRepresentation();
        g.setName(name);
        return g;
    }

    /** An OIDC broker pointing at an unresolvable host, so nothing ever leaves the test network. */
    private static IdentityProviderRepresentation identityProvider() {
        IdentityProviderRepresentation idp = new IdentityProviderRepresentation();
        idp.setAlias(IDP_ALIAS);
        idp.setProviderId("oidc");
        idp.setConfig(Map.of("clientId", "x", "clientSecret", "y", "authorizationUrl", "https://idp.invalid/auth",
                "tokenUrl", "https://idp.invalid/token", "clientAuthMethod", "client_secret_post"));
        return idp;
    }

    private static OrganizationRepresentation organization() {
        OrganizationRepresentation org = new OrganizationRepresentation();
        org.setName("seed-org");
        org.setAlias("seed-org");
        OrganizationDomainRepresentation domain = new OrganizationDomainRepresentation();
        domain.setName("seed.example");
        org.addDomain(domain);
        return org;
    }
}
