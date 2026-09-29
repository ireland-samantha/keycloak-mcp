package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.resource.AuthenticationManagementResource;
import org.keycloak.representations.idm.AuthenticationFlowRepresentation;
import org.keycloak.representations.idm.AuthenticatorConfigRepresentation;

import java.util.Map;

/** A top-level flow of its own (the built-in flows stay untouched) with one execution that carries a config. */
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
