package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.Keycloak;
import org.keycloak.representations.idm.RealmRepresentation;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;

/**
 * Creates a disposable realm holding at least one entity of every kind the admin API reads or addresses by id or
 * name, with the relations that make reads non-trivial: composite roles, subgroups, memberships and role mappings,
 * a user with a password, a federated identity, a consent and live sessions, identity-provider mappers, a key
 * provider and an LDAP component, a configured authentication flow, an organization with a domain, members, an
 * identity-provider link, groups and an invitation, client policies, localization texts, events and a workflow,
 * and a resource server with a policy of every type the admin client can create.
 *
 * <p>Nothing leaves the test network: the identity provider and LDAP server are unresolvable or non-routable, the
 * LDAP component is disabled, and mail goes to the {@code SmtpSink} named in the {@link Context}.
 */
public final class RealmSeeder {

    /**
     * @param serverUrl root URL of the server, for the logins that create sessions
     * @param smtpHost  host under which the server reaches the mail sink
     * @param smtpPort  its port
     */
    public record Context(String serverUrl, String smtpHost, int smtpPort) {
    }

    public static final String USER = "seed-user";
    /** Realm and client role, both composite (of {@link #CHILD_ROLE} of the realm and of the client). */
    public static final String ROLE = "seed-role";
    public static final String CHILD_ROLE = "seed-child-role";
    public static final String GROUP = "seed-group";
    public static final String SUB_GROUP = "seed-sub-group";
    public static final String ORG_GROUP = "seed-org-group";
    public static final String WORKFLOW = "seed-workflow";
    public static final String IDP_ALIAS = "seed-idp";
    public static final String CLIENT = "seed-authz";
    public static final String SCOPE_NAME = "seed-scope";
    public static final String TEMPLATE_SCOPE_NAME = "seed-template-scope";
    public static final String FLOW = "seed-flow";
    public static final String LOCALE = "en";
    public static final String LOCALIZATION_KEY = "seed.key";
    public static final String DOMAIN = "seed.example";
    /** Policy names; each typed policy gets its own so deleting one type cannot remove another's target. */
    public static final String USER_POLICY = "p-user";

    private static final SecureRandom RANDOM = new SecureRandom();

    private final Keycloak admin;
    private final Context context;

    public RealmSeeder(Keycloak admin, Context context) {
        this.admin = admin;
        this.context = context;
    }

    /** Creates realm {@code name} and populates it. The caller owns the result and must close it. */
    public SeededRealm seed(String name) {
        admin.realms().create(realm(name));
        Seeding s = new Seeding(name, admin.realm(name), context);
        s.step(SeededRealm.REALM_ID, () -> s.realm.toRepresentation().getId());
        RealmSettingsSeeding.seed(s);
        RoleAndGroupSeeding.realmRoles(s);
        ClientSeeding.seed(s);
        RoleAndGroupSeeding.groups(s);
        IdentityProviderSeeding.seed(s);
        UserSeeding.seed(s);
        ComponentSeeding.seed(s);
        AuthenticationSeeding.seed(s);
        OrganizationSeeding.seed(s);
        WorkflowSeeding.seed(s);
        AuthorizationSeeding.seed(s);
        SessionSeeding.seed(s);
        return new SeededRealm(admin, name, s.ids(), s.log());
    }

    /** A random secret for a seeded credential; seeded realms are disposable, so it is never reused. */
    static String secret() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    private RealmRepresentation realm(String name) {
        RealmRepresentation realm = new RealmRepresentation();
        realm.setRealm(name);
        realm.setEnabled(true);
        realm.setOrganizationsEnabled(true);
        realm.setVerifiableCredentialsEnabled(true);
        // One failed login shows up in the brute-force status without ever locking the seeded user out.
        realm.setBruteForceProtected(true);
        realm.setFailureFactor(1000);
        realm.setSmtpServer(Map.of("host", context.smtpHost(), "port", String.valueOf(context.smtpPort()),
                "from", "noreply@" + DOMAIN));
        return realm;
    }
}
