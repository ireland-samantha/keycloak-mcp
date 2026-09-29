package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.common.util.MultivaluedHashMap;
import org.keycloak.representations.idm.ComponentRepresentation;

import java.util.Map;

/** A key provider, and an LDAP user-storage component the server never contacts. */
final class ComponentSeeding {

    private ComponentSeeding() {
    }

    static void seed(Seeding s) {
        s.step(SeededRealm.KEY_PROVIDER_ID, () -> Seeding.created(s.realm.components().add(component(s,
                "seed-keys", "rsa-generated", "org.keycloak.keys.KeyProvider", Map.of("priority", "10", "keySize", "2048")))));
        s.step(SeededRealm.CERTIFICATE, () -> s.realm.keys().getKeyMetadata().getKeys().stream()
                .filter(k -> s.id(SeededRealm.KEY_PROVIDER_ID).equals(k.getProviderId()) && k.getCertificate() != null)
                .findFirst().orElseThrow().getCertificate());
        // Disabled, so user lookups skip it; 192.0.2.1 is TEST-NET-1 (RFC 5737) in case anything connects anyway.
        // Creating it validates the configuration only (LDAPStorageProviderFactory.java:268-334) and adds the
        // default mappers as sub-components (:392).
        s.step(SeededRealm.COMPONENT_ID, () -> Seeding.created(s.realm.components().add(component(s,
                "seed-ldap", "ldap", "org.keycloak.storage.UserStorageProvider", Map.ofEntries(
                        Map.entry("enabled", "false"),
                        Map.entry("editMode", "READ_ONLY"),
                        Map.entry("vendor", "other"),
                        Map.entry("connectionUrl", "ldap://192.0.2.1:389"),
                        Map.entry("connectionTimeout", "1000"),
                        Map.entry("readTimeout", "1000"),
                        Map.entry("usersDn", "ou=people,dc=seed,dc=example"),
                        Map.entry("usernameLDAPAttribute", "uid"),
                        Map.entry("rdnLDAPAttribute", "uid"),
                        Map.entry("uuidLDAPAttribute", "entryUUID"),
                        Map.entry("userObjectClasses", "inetOrgPerson, organizationalPerson"),
                        Map.entry("authType", "none"),
                        Map.entry("importEnabled", "true"))))));
    }

    private static ComponentRepresentation component(Seeding s, String name, String providerId, String type,
                                                     Map<String, String> config) {
        ComponentRepresentation c = new ComponentRepresentation();
        c.setName(name);
        c.setProviderId(providerId);
        c.setProviderType(type);
        c.setParentId(s.id(SeededRealm.REALM_ID));
        MultivaluedHashMap<String, String> values = new MultivaluedHashMap<>();
        config.forEach(values::putSingle);
        c.setConfig(values);
        return c;
    }
}
