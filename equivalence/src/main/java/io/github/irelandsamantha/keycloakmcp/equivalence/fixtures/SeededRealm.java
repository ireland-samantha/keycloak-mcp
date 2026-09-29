package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import jakarta.ws.rs.NotFoundException;
import org.keycloak.admin.client.Keycloak;

import java.util.List;
import java.util.Map;

/**
 * A realm created by {@link RealmSeeder}: its name, the ids of the seeded entities by fixture key, and the log of
 * seeding steps that failed. Closing it deletes the realm (tolerating an operation under test having done so).
 */
public final class SeededRealm implements AutoCloseable {

    /** Value used for a path variable no fixture covers; the server answers with its own "not found". */
    public static final String MISSING = "equivalence-missing";

    public static final String REALM_ID = "realmId";
    public static final String USER_ID = "userId";
    public static final String ROLE_ID = "roleId";
    public static final String GROUP_ID = "groupId";
    public static final String SUB_GROUP_ID = "subGroupId";
    public static final String CLIENT_SCOPE_ID = "clientScopeId";
    public static final String CLIENT_TEMPLATE_ID = "clientTemplateId";
    /** The confidential client with authorization services every client-scoped path addresses. */
    public static final String CLIENT_ID = "clientUuid";
    public static final String CLIENT_ROLE = "clientRoleName";
    public static final String PUBLIC_CLIENT_ID = "publicClientUuid";
    public static final String BEARER_CLIENT_ID = "bearerOnlyClientUuid";
    public static final String SAML_CLIENT_ID = "samlClientUuid";
    public static final String CLIENT_MAPPER_ID = "clientProtocolMapperId";
    public static final String SCOPE_MAPPER_ID = "clientScopeProtocolMapperId";
    public static final String TEMPLATE_MAPPER_ID = "clientTemplateProtocolMapperId";
    /** The disabled LDAP user-storage component: the only kind with sub-component types. */
    public static final String COMPONENT_ID = "componentId";
    public static final String KEY_PROVIDER_ID = "keyProviderId";
    public static final String FLOW_ID = "flowId";
    /** An execution of the seeded flow that carries {@link #AUTH_CONFIG_ID}. */
    public static final String EXECUTION_ID = "executionId";
    public static final String AUTH_CONFIG_ID = "authenticatorConfigId";
    public static final String IDP = "idpAlias";
    public static final String IDP_MAPPER_ID = "idpMapperId";
    public static final String ORG_ID = "orgId";
    public static final String ORG_MEMBER = "orgMember";
    public static final String ORG_GROUP_ID = "orgGroupId";
    public static final String INVITATION_ID = "invitationId";
    public static final String WORKFLOW_ID = "workflowId";
    public static final String RESOURCE_ID = "resourceId";
    public static final String SCOPE_ID = "scopeId";

    private final Keycloak admin;
    private final String name;
    private final Map<String, String> ids;
    private final List<String> log;

    SeededRealm(Keycloak admin, String name, Map<String, String> ids, List<String> log) {
        this.admin = admin;
        this.name = name;
        this.ids = ids;
        this.log = log;
    }

    /** Fixture key of the typed authorization policy, e.g. {@code policy.user}. */
    public static String policy(String type) {
        return "policy." + type;
    }

    /** Fixture key of the typed authorization permission, e.g. {@code permission.scope}. */
    public static String permission(String type) {
        return "permission." + type;
    }

    public String name() {
        return name;
    }

    /** Seeded id for a fixture key, or {@link #MISSING} when that seeding step failed. */
    public String id(String key) {
        return ids.getOrDefault(key, MISSING);
    }

    /** Seeding steps that failed, as {@code key: exception}. */
    public List<String> log() {
        return log;
    }

    @Override
    public void close() {
        try {
            admin.realm(name).remove();
        } catch (NotFoundException alreadyDeleted) {
            // DELETE /admin/realms/{realm} is itself an operation under test
        }
    }
}
