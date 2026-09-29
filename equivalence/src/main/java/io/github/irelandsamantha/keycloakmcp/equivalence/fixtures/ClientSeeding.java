package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.resource.ClientResource;
import org.keycloak.admin.client.resource.ProtocolMappersResource;
import org.keycloak.representations.idm.ClientRepresentation;
import org.keycloak.representations.idm.ClientScopeRepresentation;
import org.keycloak.representations.idm.ProtocolMapperRepresentation;
import org.keycloak.representations.idm.RoleRepresentation;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Clients of every access type (confidential with service account and authorization services, public, bearer-only,
 * SAML), the confidential client's roles (composite like the realm's), two client scopes with scope mappings, and
 * a protocol mapper on the confidential client and on each scope.
 */
final class ClientSeeding {

    private ClientSeeding() {
    }

    static void seed(Seeding s) {
        s.step(SeededRealm.CLIENT_ID, () -> Seeding.created(s.realm.clients().create(client(RealmSeeder.CLIENT, c -> {
            c.setPublicClient(false);
            c.setSecret(s.clientSecret);
            c.setServiceAccountsEnabled(true);
            c.setAuthorizationServicesEnabled(true);
            c.setDirectAccessGrantsEnabled(true);
        }))));
        s.step(SeededRealm.PUBLIC_CLIENT_ID, () -> Seeding.created(s.realm.clients().create(client("seed-public", c -> {
            c.setPublicClient(true);
            c.setDirectAccessGrantsEnabled(true);
            c.setRedirectUris(List.of("https://app." + RealmSeeder.DOMAIN + "/*"));
            c.setWebOrigins(List.of("https://app." + RealmSeeder.DOMAIN));
        }))));
        s.step(SeededRealm.BEARER_CLIENT_ID, () -> Seeding.created(s.realm.clients().create(client("seed-bearer",
                c -> c.setBearerOnly(true)))));
        s.step(SeededRealm.SAML_CLIENT_ID, () -> Seeding.created(s.realm.clients().create(client("seed-saml", c -> {
            c.setProtocol("saml");
            c.setRedirectUris(List.of("https://sp." + RealmSeeder.DOMAIN + "/*"));
            c.setAttributes(Map.of("saml_assertion_consumer_url_post", "https://sp." + RealmSeeder.DOMAIN + "/acs"));
        }))));
        clientRoles(s);
        clientScopes(s);
        protocolMappers(s);
    }

    private static void clientRoles(Seeding s) {
        s.step(SeededRealm.CLIENT_ROLE, () -> {
            ClientResource client = s.realm.clients().get(s.id(SeededRealm.CLIENT_ID));
            client.roles().create(RoleAndGroupSeeding.role(RealmSeeder.CHILD_ROLE));
            client.roles().create(RoleAndGroupSeeding.role(RealmSeeder.ROLE));
            return RealmSeeder.ROLE;
        });
        s.run("role composites", () -> {
            ClientResource client = s.realm.clients().get(s.id(SeededRealm.CLIENT_ID));
            List<RoleRepresentation> children = List.of(
                    s.realm.roles().get(RealmSeeder.CHILD_ROLE).toRepresentation(),
                    client.roles().get(RealmSeeder.CHILD_ROLE).toRepresentation());
            s.realm.roles().get(RealmSeeder.ROLE).addComposites(children);
            client.roles().get(RealmSeeder.ROLE).addComposites(children);
        });
    }

    private static void clientScopes(Seeding s) {
        s.step(SeededRealm.CLIENT_SCOPE_ID, () -> Seeding.created(s.realm.clientScopes().create(clientScope(RealmSeeder.SCOPE_NAME))));
        // client-templates is an alias of client-scopes (RealmAdminResource.java:219-223) whose {id} locator
        // rejects an unknown scope (ClientScopesResource.java:148-155); its own scope survives
        // DELETE client-scopes/{id}, which the route probe sends first.
        s.step(SeededRealm.CLIENT_TEMPLATE_ID, () -> Seeding.created(s.realm.clientScopes().create(clientScope(RealmSeeder.TEMPLATE_SCOPE_NAME))));
        s.run("client scope assignments", () -> {
            s.realm.addDefaultOptionalClientScope(s.id(SeededRealm.CLIENT_SCOPE_ID));
            s.realm.clients().get(s.id(SeededRealm.CLIENT_ID)).addOptionalClientScope(s.id(SeededRealm.CLIENT_SCOPE_ID));
        });
        s.run("scope mappings", () -> {
            String client = s.id(SeededRealm.CLIENT_ID);
            List<RoleRepresentation> realmRole = List.of(s.realm.roles().get(RealmSeeder.ROLE).toRepresentation());
            List<RoleRepresentation> clientRole = List.of(s.realm.clients().get(client).roles().get(RealmSeeder.ROLE).toRepresentation());
            for (String scope : List.of(s.id(SeededRealm.CLIENT_SCOPE_ID), s.id(SeededRealm.CLIENT_TEMPLATE_ID))) {
                s.realm.clientScopes().get(scope).getScopeMappings().realmLevel().add(realmRole);
                s.realm.clientScopes().get(scope).getScopeMappings().clientLevel(client).add(clientRole);
            }
            ClientResource authz = s.realm.clients().get(client);
            authz.getScopeMappings().realmLevel().add(realmRole);
            authz.getScopeMappings().clientLevel(client).add(clientRole);
        });
    }

    private static void protocolMappers(Seeding s) {
        s.step(SeededRealm.CLIENT_MAPPER_ID, () -> addMapper(
                s.realm.clients().get(s.id(SeededRealm.CLIENT_ID)).getProtocolMappers()));
        s.step(SeededRealm.SCOPE_MAPPER_ID, () -> addMapper(
                s.realm.clientScopes().get(s.id(SeededRealm.CLIENT_SCOPE_ID)).getProtocolMappers()));
        s.step(SeededRealm.TEMPLATE_MAPPER_ID, () -> addMapper(
                s.realm.clientScopes().get(s.id(SeededRealm.CLIENT_TEMPLATE_ID)).getProtocolMappers()));
    }

    private static String addMapper(ProtocolMappersResource mappers) {
        ProtocolMapperRepresentation mapper = new ProtocolMapperRepresentation();
        mapper.setName("seed-claim");
        mapper.setProtocol("openid-connect");
        mapper.setProtocolMapper("oidc-hardcoded-claim-mapper");
        mapper.setConfig(Map.of("claim.name", "seed_claim", "claim.value", "seeded", "jsonType.label", "String",
                "access.token.claim", "true", "id.token.claim", "true", "userinfo.token.claim", "true"));
        return Seeding.created(mappers.createMapper(mapper));
    }

    private static ClientRepresentation client(String clientId, Consumer<ClientRepresentation> customize) {
        ClientRepresentation c = new ClientRepresentation();
        c.setClientId(clientId);
        c.setEnabled(true);
        customize.accept(c);
        return c;
    }

    private static ClientScopeRepresentation clientScope(String name) {
        ClientScopeRepresentation cs = new ClientScopeRepresentation();
        cs.setName(name);
        cs.setProtocol("openid-connect");
        return cs;
    }
}
