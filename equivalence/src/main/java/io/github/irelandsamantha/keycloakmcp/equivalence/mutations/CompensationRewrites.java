package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.util.List;
import java.util.Optional;

/**
 * keycloak-mcp's documented rewrites of a declared compensation, which its rollback then names instead of the
 * declared one. A role is created under, and addressed by, the name in its body, and a later rename can give that name
 * to another role; so right after a role create keycloak-mcp reads the role by that name for its id, and compensates
 * with {@code DELETE .../roles-by-id/{role-id}} whatever the role is called by then (keycloak-mcp README, "Write
 * safety and actual guarantees"; {@code src/policy/table.js} {@code NAMED_CREATE_TARGETS} with {@code deleteById};
 * {@code src/workflow/compensation.js} {@code pinToCreatedId}). Client roles share the realm-wide roles-by-id route.
 *
 * <p>The identity-provider create, the third named create, has no rewrite: Keycloak has no route by
 * {@code internalId}, so keycloak-mcp keeps the declared {@code DELETE .../identity-provider/instances/{alias}} and
 * only checks, right before sending it, that the alias still has the created {@code internalId}
 * ({@code verifyCompensationTarget}); its rollback names the declared compensation.
 */
final class CompensationRewrites {

    /**
     * @param operation the create, as the reference names it
     * @param declared  the compensation a client declares for it
     * @param performed the compensation keycloak-mcp runs instead
     */
    record Rewrite(String operation, String declared, String performed) {
    }

    private static final String ROLE_BY_ID = "DELETE /admin/realms/{realm}/roles-by-id/{role-id}";

    static final List<Rewrite> REWRITES = List.of(
            new Rewrite("POST /admin/realms/{realm}/roles", "DELETE /admin/realms/{realm}/roles/{role-name}", ROLE_BY_ID),
            new Rewrite("POST /admin/realms/{realm}/clients/{client-uuid}/roles",
                    "DELETE /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}", ROLE_BY_ID));

    private CompensationRewrites() {
    }

    /**
     * The compensation keycloak-mcp documents running instead of {@code declared} for {@code operation}, if any.
     * Operations match by name-free key, so any source's variable names do.
     */
    static Optional<String> performedInstead(String operation, String declared) {
        return REWRITES.stream().filter(r -> nameFree(r.operation()).equals(nameFree(operation))
                && nameFree(r.declared()).equals(nameFree(declared))).map(Rewrite::performed).findFirst();
    }

    /** Whether {@code reported} is {@code declared} or the documented rewrite of it for {@code operation}. */
    static boolean isCompensation(String operation, String declared, String reported) {
        return nameFree(reported).equals(nameFree(declared))
                || performedInstead(operation, declared).map(p -> nameFree(p).equals(nameFree(reported))).orElse(false);
    }

    private static String nameFree(String key) {
        int space = key.indexOf(' ');
        return PathTemplates.operationKey(key.substring(0, space), key.substring(space + 1));
    }
}
