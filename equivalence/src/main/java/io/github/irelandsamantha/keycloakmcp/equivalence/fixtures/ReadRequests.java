package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.KeystoreContent;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.UnaryOperator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a read needs beyond its path to return something real: the search term of a search, the component type of
 * sub-component types, the user of a token example, the entity of a read-only POST. Operations are matched by
 * name-free key, so every source's spelling of a path gets the same arguments.
 */
public final class ReadRequests {

    /**
     * One entity a read-only POST is sent with, and how the answers to it are compared.
     *
     * @param name {@code null} when the operation is read with this entity only
     */
    private record Variant(String name, ReadBody body, UnaryOperator<JsonNode> view) {
    }

    private record Rule(Pattern key, Function<Matcher, Function<SeededRealm, Map<String, String>>> query,
                        Function<SeededRealm, List<Variant>> bodies) {
    }

    /** Passwords of the downloaded keystores; the seeded client's certificate is public, so nothing is protected. */
    static final String STORE_PASSWORD = "seed-store-password";
    static final String KEY_PASSWORD = "seed-key-password";
    /** Aliases the download is asked for, so they do not depend on the client id or the realm name. */
    static final String CLIENT_ALIAS = "seed-client";
    static final String REALM_ALIAS = "seed-realm";

    private static final List<Rule> RULES = new ArrayList<>();

    static {
        query("GET .*/authz/resource-server/policy/([a-z-]+)/search", m -> realm -> Map.of("name", RealmSeeder.policyName(m.group(1))));
        query("GET .*/authz/resource-server/permission/([a-z-]+)/search", m -> realm -> Map.of("name", RealmSeeder.permissionName(m.group(1))));
        query("GET .*/authz/resource-server/policy/search", m -> realm -> Map.of("name", RealmSeeder.USER_POLICY));
        query("GET .*/authz/resource-server/permission/search", m -> realm -> Map.of("name", RealmSeeder.permissionName("scope")));
        query("GET .*/authz/resource-server/resource/search", m -> realm -> Map.of("name", RealmSeeder.RESOURCE));
        query("GET .*/authz/resource-server/scope/search", m -> realm -> Map.of("name", RealmSeeder.SCOPE_NAME));
        // Without a type the server answers 400 (ComponentResource.java:249-250).
        query("GET .*/components/\\{}/sub-component-types", m -> realm -> Map.of("type", "org.keycloak.storage.ldap.mappers.LDAPStorageMapper"));
        // Without a user the examples answer 404 (ClientScopeEvaluateResource.java:420-423).
        query("GET .*/evaluate-scopes/generate-example-[a-z-]+", m -> realm -> Map.of("userId", realm.id(SeededRealm.USER_ID)));
        body("POST /admin/realms/\\{}/client-description-converter", realm -> ReadBody.json(Map.of(
                "client_name", "converted-client", "redirect_uris", List.of("https://app." + RealmSeeder.DOMAIN + "/cb"))));
        body("POST /admin/realms/\\{}/identity-provider/upload-certificate", realm -> {
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("keystoreFormat", "Certificate PEM");
            fields.put("file", new ReadBody.Multipart.File("seed.pem", "application/x-pem-file",
                    ("-----BEGIN CERTIFICATE-----\n" + realm.id(SeededRealm.CERTIFICATE) + "\n-----END CERTIFICATE-----\n")
                            .getBytes(StandardCharsets.US_ASCII)));
            return new ReadBody.Multipart(fields);
        });
        // The seeded user against the seeded resource, which the user policy behind every seeded permission grants.
        // The request needs a user: a null entity fails on its first field (PolicyEvaluationService.java:316), and a
        // token without a subject fails to become an identity (:279, :395; "Error while reading attributes from
        // security token" on nightly); the admin console always names one. Policy and permission evaluation are the
        // same service (PolicyService.java:347-354; PermissionService.java:37 extends PolicyService).
        body("POST .*/authz/resource-server/(policy|permission)/evaluate", realm -> ReadBody.json(Map.of(
                "userId", realm.id(SeededRealm.USER_ID),
                "resources", List.of(Map.of("_id", realm.id(SeededRealm.RESOURCE_ID))),
                "context", Map.of("attributes", Map.of()),
                "entitlements", false)));
        // A store password and a format are required (ClientAttributeCertificateResource.java:242-244, :306-307). The
        // seeded client has a certificate and, as every client on HEAD, no stored private key (CertificateInfoHelper.java:
        // 80-96 never reads one), so the keystore holds the client's and the realm's certificates as trusted entries.
        variants("POST .*/clients/\\{}/certificates/\\{}/download", realm -> List.of(keystore("JKS"), keystore("PKCS12")));
    }

    private ReadRequests() {
    }

    /**
     * The reads of {@code method template} in {@code realm}, with arguments where the operation needs them: one
     * request, or one per entity the operation is read with.
     */
    public static List<ReadRequest> forOperation(String method, String template, List<String> pathValues, String accept,
                                                 SeededRealm realm) {
        String key = PathTemplates.operationKey(method, template);
        Map<String, String> query = new LinkedHashMap<>();
        List<Variant> variants = List.of(new Variant(null, null, UnaryOperator.identity()));
        for (Rule rule : RULES) {
            Matcher m = rule.key().matcher(key);
            if (m.matches()) {
                if (rule.query() != null) {
                    query.putAll(rule.query().apply(m).apply(realm));
                }
                if (rule.bodies() != null) {
                    variants = rule.bodies().apply(realm);
                }
                break;
            }
        }
        Map<String, String> fixed = Map.copyOf(query);
        return variants.stream().map(v -> new ReadRequest(method, template, pathValues, fixed, v.body(), accept,
                v.name(), v.view())).toList();
    }

    /** A {@code KeyStoreConfig} for a download in {@code format}, compared by what the keystore holds. */
    private static Variant keystore(String format) {
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("format", format);
        config.put("keyAlias", CLIENT_ALIAS);
        config.put("keyPassword", KEY_PASSWORD);
        config.put("storePassword", STORE_PASSWORD);
        config.put("realmCertificate", true);
        config.put("realmAlias", REALM_ALIAS);
        return new Variant(format, ReadBody.json(config),
                KeystoreContent.view(new KeystoreContent.Opening(format, STORE_PASSWORD, KEY_PASSWORD)));
    }

    private static void query(String key, Function<Matcher, Function<SeededRealm, Map<String, String>>> query) {
        RULES.add(new Rule(Pattern.compile(key), query, null));
    }

    private static void body(String key, Function<SeededRealm, ReadBody> body) {
        variants(key, realm -> List.of(new Variant(null, body.apply(realm), UnaryOperator.identity())));
    }

    private static void variants(String key, Function<SeededRealm, List<Variant>> bodies) {
        RULES.add(new Rule(Pattern.compile(key), null, bodies));
    }
}
