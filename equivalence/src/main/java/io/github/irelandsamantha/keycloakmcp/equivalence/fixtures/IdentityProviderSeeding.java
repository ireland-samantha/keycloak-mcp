package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.representations.idm.IdentityProviderMapperRepresentation;
import org.keycloak.representations.idm.IdentityProviderRepresentation;

import java.util.Map;

/**
 * An OIDC broker with one mapper and a SAML broker, both pointing at an unresolvable host so nothing ever leaves
 * the test network.
 */
final class IdentityProviderSeeding {

    private static final String SAML_ALIAS = "seed-saml-idp";

    private IdentityProviderSeeding() {
    }

    static void seed(Seeding s) {
        s.step(SeededRealm.IDP, () -> {
            Seeding.ensure2xx(s.realm.identityProviders().create(identityProvider()));
            return RealmSeeder.IDP_ALIAS;
        });
        s.step(SeededRealm.IDP_MAPPER_ID, () -> Seeding.created(s.realm.identityProviders()
                .get(s.id(SeededRealm.IDP)).addMapper(mapper())));
        s.step(SeededRealm.SAML_IDP, () -> {
            Seeding.ensure2xx(s.realm.identityProviders().create(samlIdentityProvider()));
            return SAML_ALIAS;
        });
    }

    private static IdentityProviderRepresentation samlIdentityProvider() {
        IdentityProviderRepresentation idp = new IdentityProviderRepresentation();
        idp.setAlias(SAML_ALIAS);
        idp.setProviderId("saml");
        idp.setConfig(Map.of("singleSignOnServiceUrl", "https://idp.invalid/saml", "nameIDPolicyFormat",
                "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"));
        return idp;
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
