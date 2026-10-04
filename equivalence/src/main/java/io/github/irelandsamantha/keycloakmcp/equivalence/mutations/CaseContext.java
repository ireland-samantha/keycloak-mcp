package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.ExternalSystems;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * One realm of a case as its family and cases see it: its name, its entities by natural key, raw JSON requests
 * below {@code /admin/realms/{realm}/} for seeding and for reading what a compensation must restore, and the systems
 * outside Keycloak the server can be given to reach.
 */
public final class CaseContext {

    private final String realm;
    private final RawHttp http;
    private final ExternalSystems systems;
    private Map<String, String> ids = Map.of();

    private CaseContext(String realm, RawHttp http, ExternalSystems systems) {
        this.realm = realm;
        this.http = http;
        this.systems = systems;
    }

    /** Realm {@code realm} as the raw oracle {@code http} reaches it, without systems to reach. */
    public static CaseContext of(String realm, RawHttp http) {
        return new CaseContext(realm, http, null);
    }

    /** Realm {@code realm} as the raw oracle {@code http} reaches it, and the run's {@code systems}. */
    public static CaseContext of(String realm, RawHttp http, ExternalSystems systems) {
        return new CaseContext(realm, http, systems);
    }

    public String realm() {
        return realm;
    }

    /**
     * Systems outside Keycloak the server reaches, addressed as it sees them: start an LDAP container or expose an
     * HTTP sink here, then configure the realm with the returned address. Shared by every twin of the run.
     */
    public ExternalSystems systems() {
        if (systems == null) {
            throw new IllegalStateException("Realm " + realm + " was created without systems to reach");
        }
        return systems;
    }

    /** The id of the entity with this natural key (see {@link NaturalKeys}). */
    public String id(String naturalKey) {
        String id = ids.get(naturalKey);
        if (id == null) {
            ids = NaturalKeys.index(http, realm);
            id = ids.get(naturalKey);
        }
        if (id == null) {
            throw new IllegalStateException("Realm " + realm + " has no " + naturalKey);
        }
        return id;
    }

    /** {@code GET /admin/realms/{realm}/<path>}: the JSON of a 200 answer. */
    public JsonNode get(String path) {
        return ServerCalls.get(http, url(path));
    }

    /** {@code POST /admin/realms/{realm}/<path>} that must answer 201; returns the id its {@code Location} ends in. */
    public String create(String path, JsonNode body) {
        RawHttp.Response r = ServerCalls.send(http, "POST", url(path), body);
        String location = r.header("Location");
        if (r.status() != 201 || location == null) {
            throw new IllegalStateException("POST " + url(path) + ": HTTP " + r.status() + " " + r.text());
        }
        String created = URI.create(location).getRawPath();
        return URLDecoder.decode(created.substring(created.lastIndexOf('/') + 1), StandardCharsets.UTF_8);
    }

    /** A request below the realm that must answer 2xx; {@code body} may be null. */
    public void send(String method, String path, JsonNode body) {
        ServerCalls.expect2xx(ServerCalls.send(http, method, url(path), body), method + " " + url(path));
    }

    RawHttp http() {
        return http;
    }

    private String url(String path) {
        return "/admin/realms/" + RawHttp.segment(realm) + "/" + path;
    }
}
