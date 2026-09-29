package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.keycloak.representations.idm.ClientInitialAccessCreatePresentation;
import org.keycloak.representations.idm.ClientPoliciesRepresentation;
import org.keycloak.representations.idm.ClientPolicyConditionRepresentation;
import org.keycloak.representations.idm.ClientPolicyExecutorRepresentation;
import org.keycloak.representations.idm.ClientPolicyRepresentation;
import org.keycloak.representations.idm.ClientProfileRepresentation;
import org.keycloak.representations.idm.ClientProfilesRepresentation;
import org.keycloak.representations.idm.RealmEventsConfigRepresentation;
import org.keycloak.representations.userprofile.config.UPConfig;

import java.util.List;

/** Realm-wide settings: events, localization, user profile, client policies, initial-access tokens. */
final class RealmSettingsSeeding {

    static final String CLIENT_PROFILE = "seed-secret-rotation";

    private RealmSettingsSeeding() {
    }

    static void seed(Seeding s) {
        // First, so every later seeding step is also recorded as an admin event.
        s.run("events config", () -> s.realm.updateRealmEventsConfig(eventsConfig()));
        s.run("localization text", () -> s.realm.localization()
                .saveRealmLocalizationText(RealmSeeder.LOCALE, RealmSeeder.LOCALIZATION_KEY, "Seeded text"));
        s.run("user profile", () -> {
            UPConfig config = s.realm.users().userProfile().getConfiguration();
            config.setUnmanagedAttributePolicy(UPConfig.UnmanagedAttributePolicy.ENABLED);
            s.realm.users().userProfile().update(config);
        });
        s.run("client profiles", () -> s.realm.clientPoliciesProfilesResource().updateProfiles(profiles()));
        s.run("client policies", () -> s.realm.clientPoliciesPoliciesResource().updatePolicies(policies()));
        s.run("initial access token", () -> s.realm.clientInitialAccess()
                .create(new ClientInitialAccessCreatePresentation(0, 1)));
    }

    private static RealmEventsConfigRepresentation eventsConfig() {
        RealmEventsConfigRepresentation events = new RealmEventsConfigRepresentation();
        events.setEventsEnabled(true);
        events.setAdminEventsEnabled(true);
        events.setAdminEventsDetailsEnabled(true);
        return events;
    }

    /** Secret rotation keeps the previous secret readable after a regeneration (client-secret/rotated). */
    private static ClientProfilesRepresentation profiles() {
        ClientPolicyExecutorRepresentation rotation = new ClientPolicyExecutorRepresentation();
        rotation.setExecutorProviderId("secret-rotation");
        rotation.setConfiguration(JsonNodeFactory.instance.objectNode()
                .put("expiration-period", 2592000).put("rotated-expiration-period", 2592000).put("remaining-rotation-period", 864000));
        ClientProfileRepresentation profile = new ClientProfileRepresentation();
        profile.setName(CLIENT_PROFILE);
        profile.setExecutors(List.of(rotation));
        ClientProfilesRepresentation profiles = new ClientProfilesRepresentation();
        profiles.setProfiles(List.of(profile));
        return profiles;
    }

    private static ClientPoliciesRepresentation policies() {
        ObjectNode confidential = JsonNodeFactory.instance.objectNode();
        confidential.putArray("type").add("confidential");
        ClientPolicyConditionRepresentation condition = new ClientPolicyConditionRepresentation();
        condition.setConditionProviderId("client-access-type");
        condition.setConfiguration(confidential);
        ClientPolicyRepresentation policy = new ClientPolicyRepresentation();
        policy.setName("seed-policy");
        policy.setEnabled(true);
        policy.setConditions(List.of(condition));
        policy.setProfiles(List.of(CLIENT_PROFILE));
        ClientPoliciesRepresentation policies = new ClientPoliciesRepresentation();
        policies.setPolicies(List.of(policy));
        return policies;
    }
}
