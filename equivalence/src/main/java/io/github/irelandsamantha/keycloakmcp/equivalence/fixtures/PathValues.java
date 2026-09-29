package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Chooses a value for each path variable of an operation by its <em>position</em> and the literal path around it,
 * never by name: variable names differ between the OpenAPI document and the admin client (224 operations) and
 * repeat inside one admin-client chain ({@code .../clients/{id}/.../policy/{id}}).
 */
public final class PathValues {

    /**
     * @param prefix matched against the template text before the variable
     * @param suffix matched against the text after it; {@code null} matches anything
     */
    private record Rule(Pattern prefix, Pattern suffix, Function<SeededRealm, String> value) {
        boolean matches(String before, String after) {
            return prefix.matcher(before).find() && (suffix == null || suffix.matcher(after).find());
        }
    }

    private static final List<Rule> RULES = new ArrayList<>();

    static {
        // First match wins, so more specific rules come first. Earlier and later variables are written as "{}".
        literal("^/admin/realms/$", SeededRealm::name);
        for (String type : List.of("user", "role", "group", "time", "client", "client-scope", "aggregate")) {
            id("/authz/resource-server/policy/" + type + "/$", SeededRealm.policy(type));
        }
        id("/authz/resource-server/policy/$", SeededRealm.policy("generic"));
        id("/authz/resource-server/permission/resource/$", SeededRealm.permission("resource"));
        id("/authz/resource-server/permission/scope/$", SeededRealm.permission("scope"));
        id("/authz/resource-server/resource/$", SeededRealm.RESOURCE_ID);
        id("/authz/resource-server/scope/$", SeededRealm.SCOPE_ID);
        id("/attack-detection/brute-force/users/$", SeededRealm.USER_ID);
        constant("/authentication/config-description/$", "identity-provider-redirector");
        id("/authentication/config/$", SeededRealm.AUTH_CONFIG_ID);
        id("/authentication/executions/\\{}/config/$", SeededRealm.AUTH_CONFIG_ID);
        id("/authentication/executions/$", SeededRealm.EXECUTION_ID);
        // flows/{id} addresses a flow by id, flows/{flowAlias}/... by alias.
        id("/authentication/flows/$", "^$", SeededRealm.FLOW_ID);
        constant("/authentication/flows/$", RealmSeeder.FLOW);
        constant("/authentication/required-actions/$", "VERIFY_EMAIL");
        constant("/protocol-mappers/protocol/$", "openid-connect");
        id("^/admin/realms/\\{}/clients/\\{}/protocol-mappers/models/$", SeededRealm.CLIENT_MAPPER_ID);
        id("^/admin/realms/\\{}/client-scopes/\\{}/protocol-mappers/models/$", SeededRealm.SCOPE_MAPPER_ID);
        id("^/admin/realms/\\{}/client-templates/\\{}/protocol-mappers/models/$", SeededRealm.TEMPLATE_MAPPER_ID);
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
        id("^/admin/realms/\\{}/clients/$", "^/evaluate-scopes/generate-example-saml-response$", SeededRealm.SAML_CLIENT_ID);
        id("/clients/$", SeededRealm.CLIENT_ID);
        id("/components/$", SeededRealm.COMPONENT_ID);
        id("/default-groups/$", SeededRealm.GROUP_ID);
        constant("^/admin/realms/\\{}/group-by-path/$", RealmSeeder.GROUP);
        id("/groups/\\{}/members/$", SeededRealm.USER_ID);
        id("^/admin/realms/\\{}/groups/$", SeededRealm.GROUP_ID);
        id("/identity-provider/instances/\\{}/mappers/$", SeededRealm.IDP_MAPPER_ID);
        id("/identity-provider/instances/$", SeededRealm.IDP);
        constant("/identity-provider/providers/$", "oidc");
        constant("/localization/\\{}/$", RealmSeeder.LOCALIZATION_KEY);
        constant("/localization/$", RealmSeeder.LOCALE);
        id("/organizations/members/$", SeededRealm.USER_ID);
        id("/organizations/\\{}/members/$", SeededRealm.ORG_MEMBER);
        id("/organizations/\\{}/identity-providers/$", SeededRealm.IDP);
        id("/organizations/\\{}/invitations/$", SeededRealm.INVITATION_ID);
        constant("/organizations/\\{}/groups/group-by-path/$", RealmSeeder.ORG_GROUP);
        id("/organizations/\\{}/groups/$", SeededRealm.ORG_GROUP_ID);
        id("/organizations/$", SeededRealm.ORG_ID);
        id("/roles-by-id/$", SeededRealm.ROLE_ID);
        constant("/roles/$", RealmSeeder.ROLE);
        constant("/users/\\{}/consents/$", RealmSeeder.CLIENT);
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
        String before = around(template, position, true);
        String after = around(template, position, false);
        return RULES.stream()
                .filter(rule -> rule.matches(before, after))
                .findFirst()
                .map(rule -> rule.value().apply(realm))
                .orElse(SeededRealm.MISSING);
    }

    /** Template text before the {@code position}-th variable, with earlier variables written as "{}". */
    static String prefixBefore(String template, int position) {
        return around(template, position, true);
    }

    /** Template text before or after the {@code position}-th variable, other variables written as "{}". */
    private static String around(String template, int position, boolean before) {
        StringBuilder out = new StringBuilder();
        int seen = 0;
        boolean found = false;
        for (PathTemplates.Part part : PathTemplates.parse(template)) {
            switch (part) {
                case PathTemplates.Literal l -> {
                    if (found != before) {
                        out.append(l.text());
                    }
                }
                case PathTemplates.Variable v -> {
                    if (seen++ == position) {
                        if (before) {
                            return out.toString();
                        }
                        found = true;
                    } else if (found != before) {
                        out.append("{}");
                    }
                }
            }
        }
        if (!found) {
            throw new IllegalArgumentException("No variable #" + position + " in " + template);
        }
        return out.toString();
    }

    private static void id(String prefix, String fixtureKey) {
        id(prefix, null, fixtureKey);
    }

    private static void id(String prefix, String suffix, String fixtureKey) {
        RULES.add(new Rule(Pattern.compile(prefix), suffix == null ? null : Pattern.compile(suffix),
                realm -> realm.id(fixtureKey)));
    }

    private static void constant(String prefix, String value) {
        RULES.add(new Rule(Pattern.compile(prefix), null, realm -> value));
    }

    private static void literal(String prefix, Function<SeededRealm, String> value) {
        RULES.add(new Rule(Pattern.compile(prefix), null, value));
    }
}
