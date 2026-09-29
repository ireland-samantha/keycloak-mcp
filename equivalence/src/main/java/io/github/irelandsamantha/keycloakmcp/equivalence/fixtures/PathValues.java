package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Chooses a value for each path variable of an operation by its <em>position</em> and the literal path before it,
 * never by name: variable names differ between the OpenAPI document and the admin client (224 operations) and
 * repeat inside one admin-client chain ({@code .../clients/{id}/.../policy/{id}}).
 */
public final class PathValues {

    private record Rule(Pattern prefix, Function<SeededRealm, String> value) {
    }

    private static final List<Rule> RULES = new ArrayList<>();

    static {
        // First match wins, so more specific prefixes come first. The prefix is the template text before the
        // variable, with earlier variables written as "{}".
        literal("^/admin/realms/$", SeededRealm::name);
        for (String type : List.of("user", "role", "group", "time", "client", "aggregate")) {
            id("/authz/resource-server/policy/" + type + "/$", SeededRealm.policy(type));
        }
        id("/authz/resource-server/policy/$", SeededRealm.policy("generic"));
        id("/authz/resource-server/permission/resource/$", SeededRealm.permission("resource"));
        id("/authz/resource-server/permission/scope/$", SeededRealm.permission("scope"));
        id("/authz/resource-server/resource/$", SeededRealm.RESOURCE_ID);
        id("/authz/resource-server/scope/$", SeededRealm.SCOPE_ID);
        id("/attack-detection/brute-force/users/$", SeededRealm.USER_ID);
        constant("/authentication/config-description/$", "identity-provider-redirector");
        id("/authentication/executions/$", SeededRealm.EXECUTION_ID);
        constant("/authentication/flows/$", "browser");
        constant("/authentication/required-actions/$", "VERIFY_EMAIL");
        constant("/protocol-mappers/protocol/$", "openid-connect");
        id("/scope-mappings/clients/$", SeededRealm.CLIENT_ID);
        id("/composites/clients/$", SeededRealm.CLIENT_ID);
        id("/role-mappings/clients/$", SeededRealm.CLIENT_ID);
        id("/client-scopes/$", SeededRealm.CLIENT_SCOPE_ID);
        id("/client-templates/$", SeededRealm.CLIENT_TEMPLATE_ID);
        constant("/clients/\\{}/certificates/$", "jwt.credential");
        id("/default-(default|optional)-client-scopes/$", SeededRealm.CLIENT_SCOPE_ID);
        id("/default-client-scopes/$", SeededRealm.CLIENT_SCOPE_ID);
        id("/optional-client-scopes/$", SeededRealm.CLIENT_SCOPE_ID);
        id("/evaluate-scopes/scope-mappings/$", SeededRealm.CLIENT_ID);
        constant("/installation/providers/$", "keycloak-oidc-keycloak-json");
        id("/clients/\\{}/roles/$", SeededRealm.CLIENT_ROLE);
        id("/clients/$", SeededRealm.CLIENT_ID);
        id("/components/$", SeededRealm.COMPONENT_ID);
        id("/default-groups/$", SeededRealm.GROUP_ID);
        constant("^/admin/realms/\\{}/group-by-path/$", RealmSeeder.GROUP);
        id("/groups/\\{}/members/$", SeededRealm.USER_ID);
        id("^/admin/realms/\\{}/groups/$", SeededRealm.GROUP_ID);
        id("/identity-provider/instances/$", SeededRealm.IDP);
        constant("/identity-provider/providers/$", "oidc");
        constant("/localization/\\{}/$", "seed.key");
        constant("/localization/$", "en");
        id("/organizations/members/$", SeededRealm.USER_ID);
        id("/organizations/\\{}/members/$", SeededRealm.ORG_MEMBER);
        id("/organizations/\\{}/identity-providers/$", SeededRealm.IDP);
        constant("/organizations/\\{}/groups/group-by-path/$", RealmSeeder.ORG_GROUP);
        id("/organizations/\\{}/groups/$", SeededRealm.ORG_GROUP_ID);
        id("/organizations/$", SeededRealm.ORG_ID);
        id("/roles-by-id/$", SeededRealm.ROLE_ID);
        constant("/roles/$", RealmSeeder.ROLE);
        constant("/users/\\{}/consents/$", "seed-authz");
        id("/users/\\{}/federated-identity/$", SeededRealm.IDP);
        id("/users/\\{}/groups/$", SeededRealm.GROUP_ID);
        id("/users/\\{}/offline-sessions/$", SeededRealm.CLIENT_ID);
        id("/users/$", SeededRealm.USER_ID);
        id("/workflows/scheduled/$", SeededRealm.USER_ID);
        id("/workflows/\\{}/(activate|deactivate)/\\{}/$", SeededRealm.USER_ID);
        // A ResourceType constant (ResourceType.java:30): the path parameter is converted with Enum.valueOf
        // (WorkflowResource.java:159,213), and one that fails conversion is the generic 404.
        constant("/workflows/\\{}/(activate|deactivate)/$", "USERS");
        id("/workflows/$", SeededRealm.WORKFLOW_ID);
    }

    private final SeededRealm realm;

    public PathValues(SeededRealm realm) {
        this.realm = realm;
    }

    /** One raw (unencoded) value per template variable, in path order. */
    public List<String> valuesFor(String template) {
        int count = PathTemplates.variableNames(template).size();
        List<String> values = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            values.add(valueFor(template, i));
        }
        return List.copyOf(values);
    }

    /** Value for the {@code position}-th variable; {@link SeededRealm#MISSING} when no fixture covers it. */
    public String valueFor(String template, int position) {
        String prefix = prefixBefore(template, position);
        return RULES.stream()
                .filter(rule -> rule.prefix().matcher(prefix).find())
                .findFirst()
                .map(rule -> rule.value().apply(realm))
                .orElse(SeededRealm.MISSING);
    }

    /** Template text before the {@code position}-th variable, with earlier variables written as "{}". */
    static String prefixBefore(String template, int position) {
        StringBuilder out = new StringBuilder();
        int seen = 0;
        for (PathTemplates.Part part : PathTemplates.parse(template)) {
            switch (part) {
                case PathTemplates.Literal l -> out.append(l.text());
                case PathTemplates.Variable v -> {
                    if (seen++ == position) {
                        return out.toString();
                    }
                    out.append("{}");
                }
            }
        }
        throw new IllegalArgumentException("No variable #" + position + " in " + template);
    }

    private static void id(String prefix, String fixtureKey) {
        RULES.add(new Rule(Pattern.compile(prefix), realm -> realm.id(fixtureKey)));
    }

    private static void constant(String prefix, String value) {
        RULES.add(new Rule(Pattern.compile(prefix), realm -> value));
    }

    private static void literal(String prefix, Function<SeededRealm, String> value) {
        RULES.add(new Rule(Pattern.compile(prefix), value));
    }
}
