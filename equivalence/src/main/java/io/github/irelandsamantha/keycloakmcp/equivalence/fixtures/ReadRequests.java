package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a read needs beyond its path to return something real: the search term of a search, the component type of
 * sub-component types, the user of a token example, the entity of a read-only POST. Operations are matched by
 * name-free key, so every source's spelling of a path gets the same arguments.
 */
public final class ReadRequests {

    private record Rule(Pattern key, Function<Matcher, Function<SeededRealm, Map<String, String>>> query,
                        Function<SeededRealm, ReadBody> body) {
    }

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
    }

    private ReadRequests() {
    }

    /** The read of {@code method template} in {@code realm}, with arguments where the operation needs them. */
    public static ReadRequest forOperation(String method, String template, List<String> pathValues, String accept,
                                           SeededRealm realm) {
        String key = PathTemplates.operationKey(method, template);
        Map<String, String> query = new LinkedHashMap<>();
        ReadBody body = null;
        for (Rule rule : RULES) {
            Matcher m = rule.key().matcher(key);
            if (m.matches()) {
                if (rule.query() != null) {
                    query.putAll(rule.query().apply(m).apply(realm));
                }
                if (rule.body() != null) {
                    body = rule.body().apply(realm);
                }
                break;
            }
        }
        return new ReadRequest(method, template, pathValues, Map.copyOf(query), body, accept);
    }

    private static void query(String key, Function<Matcher, Function<SeededRealm, Map<String, String>>> query) {
        RULES.add(new Rule(Pattern.compile(key), query, null));
    }

    private static void body(String key, Function<SeededRealm, ReadBody> body) {
        RULES.add(new Rule(Pattern.compile(key), null, body));
    }
}
