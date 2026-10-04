package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import jakarta.ws.rs.core.Response;
import org.keycloak.admin.client.CreatedResponseUtil;
import org.keycloak.admin.client.resource.RealmResource;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * State of one seeding run: the realm being populated, the ids seeded so far by fixture key, and the log of steps
 * that failed. Steps are best-effort: a failed step leaves its key unset (path variables that need it get
 * {@link SeededRealm#MISSING}) and the failure is logged, so a later check can explain a surprising response.
 */
final class Seeding {

    final String realmName;
    final RealmResource realm;
    final RealmSeeder.Context context;
    /** Credentials of the confidential client and the seeded user, for the logins that create sessions. */
    final String clientSecret = RealmSeeder.secret();
    final String userPassword = RealmSeeder.secret();
    private final Map<String, String> ids = new LinkedHashMap<>();
    private final List<String> log = new ArrayList<>();

    Seeding(String realmName, RealmResource realm, RealmSeeder.Context context) {
        this.realmName = realmName;
        this.realm = realm;
        this.context = context;
    }

    /** Runs {@code action} and records the id it returns under {@code key}. */
    void step(String key, Supplier<String> action) {
        try {
            ids.put(key, action.get());
        } catch (RuntimeException e) {
            log.add(key + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    /** Runs an action that seeds no addressable entity (a mapping, a setting, a login). */
    void run(String description, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            log.add(description + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    /** Seeded id for {@code key}; throws inside a step whose prerequisite failed, so that step is logged too. */
    String id(String key) {
        String id = ids.get(key);
        if (id == null) {
            throw new IllegalStateException("prerequisite " + key + " was not seeded");
        }
        return id;
    }

    Map<String, String> ids() {
        return Map.copyOf(ids);
    }

    List<String> log() {
        return List.copyOf(log);
    }

    /** Id from the {@code Location} of a 201 response, which is closed. */
    static String created(Response response) {
        try (response) {
            return CreatedResponseUtil.getCreatedId(response);
        }
    }

    /** Closes a response, failing the step on a non-2xx status. */
    static void ensure2xx(Response response) {
        try (response) {
            if (response.getStatus() / 100 != 2) {
                throw new IllegalStateException("HTTP " + response.getStatus() + " " + response.readEntity(String.class));
            }
        }
    }
}
