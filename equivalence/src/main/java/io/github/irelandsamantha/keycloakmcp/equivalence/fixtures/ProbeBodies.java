package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import java.util.Map;

/**
 * Real JSON bodies for the few operations where a malformed body cannot prove routing: the server method takes the
 * raw {@code String} entity, so nothing rejects the body before the method runs, and the method then answers an
 * unknown value with a message-less {@code NotFoundException}, indistinguishable from the generic JAX-RS miss.
 */
public final class ProbeBodies {

    private ProbeBodies() {
    }

    /** Operation key (name-free) to the JSON body to send. */
    public static Map<String, String> forRealm(SeededRealm realm) {
        return Map.of(
                // OrganizationMemberResource.java:107-111 reads the user id from the raw body; getUser throws a
                // message-less NotFoundException for an unknown id (:430-435). The seeded member makes this a 409.
                "POST /admin/realms/{}/organizations/{}/members", "\"" + realm.id(SeededRealm.ORG_MEMBER) + "\"");
    }
}
