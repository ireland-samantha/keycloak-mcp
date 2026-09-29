package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.representations.idm.IdentityProviderMapperRepresentation;
import org.keycloak.representations.idm.IdentityProviderRepresentation;

import java.util.Map;

/** An OIDC broker pointing at an unresolvable host, so nothing ever leaves the test network, with one mapper. */
final class IdentityProviderSeeding {

    private IdentityProviderSeeding() {
    }

    static void seed(Seeding s) {
        s.step(SeededRealm.IDP, () -> {
            Seeding.ensure2xx(s.realm.identityProviders().create(identityProvider()));
            return RealmSeeder.IDP_ALIAS;
        });
        s.step(SeededRealm.IDP_MAPPER_ID, () -> Seeding.created(s.realm.identityProviders()
                .get(s.id(SeededRealm.IDP)).addMapper(mapper())));
    }

    private static IdentityProviderRepresentation identityProvider() {
        IdentityProviderRepresentation idp = new IdentityProviderRepresentation();
        idp.setAlias(RealmSeeder.IDP_ALIAS);
        idp.setProviderId("oidc");
        idp.setConfig(Map.of("clientId", "x", "clientSecret", "y", "authorizationUrl", "https://idp.invalid/auth",
                "tokenUrl", "https://idp.invalid/token", "clientAuthMethod", "client_secret_post"));
        return idp;
    }

    private static IdentityProviderMapperRepresentation mapper() {
        IdentityProviderMapperRepresentation mapper = new IdentityProviderMapperRepresentation();
        mapper.setName("seed-idp-mapper");
        mapper.setIdentityProviderAlias(RealmSeeder.IDP_ALIAS);
        mapper.setIdentityProviderMapper("hardcoded-attribute-idp-mapper");
        mapper.setConfig(Map.of("syncMode", "INHERIT", "attribute", "seed-brokered", "attribute.value", "true"));
        return mapper;
    }
}
