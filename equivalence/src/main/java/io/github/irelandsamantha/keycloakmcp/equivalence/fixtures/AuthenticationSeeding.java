package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.resource.AuthenticationManagementResource;
import org.keycloak.representations.idm.AuthenticationFlowRepresentation;
import org.keycloak.representations.idm.AuthenticatorConfigRepresentation;

import java.util.Map;

/**
 * A top-level flow of its own (the built-in flows stay untouched) with one execution that carries a config, and one
 * unregistered required action.
 */
final class AuthenticationSeeding {

    private AuthenticationSeeding() {
    }

    static void seed(Seeding s) {
        AuthenticationManagementResource flows = s.realm.flows();
        s.step(SeededRealm.FLOW_ID, () -> Seeding.created(flows.createFlow(flow())));
        s.step(SeededRealm.EXECUTION_ID, () -> {
            flows.addExecution(RealmSeeder.FLOW, Map.of("provider", "identity-provider-redirector"));
            return flows.getExecutions(RealmSeeder.FLOW).getFirst().getId();
        });
        s.step(SeededRealm.AUTH_CONFIG_ID, () -> {
            AuthenticatorConfigRepresentation config = new AuthenticatorConfigRepresentation();
            config.setAlias("seed-config");
            config.setConfig(Map.of("defaultProvider", RealmSeeder.IDP_ALIAS));
            return Seeding.created(flows.newExecutionConfig(s.id(SeededRealm.EXECUTION_ID), config));
        });
        // Every provided required action is registered in a new realm; one that is disabled by default is
        // unregistered, so the list of unregistered ones is not empty.
        s.run("unregistered required action", () -> flows.removeRequiredAction("TERMS_AND_CONDITIONS"));
    }

    private static AuthenticationFlowRepresentation flow() {
        AuthenticationFlowRepresentation flow = new AuthenticationFlowRepresentation();
        flow.setAlias(RealmSeeder.FLOW);
        flow.setDescription("Seeded flow");
        flow.setProviderId("basic-flow");
        flow.setTopLevel(true);
        flow.setBuiltIn(false);
        return flow;
    }
}
