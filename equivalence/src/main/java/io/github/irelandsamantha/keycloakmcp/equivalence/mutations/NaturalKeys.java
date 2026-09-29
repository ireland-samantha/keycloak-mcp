package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;

import java.util.Map;
import java.util.TreeMap;

/**
 * Natural keys of the entities in a realm (group path, role name, clientId, ...) mapped to their generated ids. Twin
 * realms seeded alike hold the same natural keys under different ids, so cases address entities by natural key and
 * readbacks are compared with every id replaced by its natural key.
 */
public final class NaturalKeys {

    public static final String REALM = "realm";

    private static final String PAGE = "first=0&max=1000";

    private NaturalKeys() {
    }

    /** A group by its path, e.g. {@code /parent/child}. */
    public static String group(String path) {
        return "group:" + path;
    }

    public static String role(String name) {
        return "role:" + name;
    }

    public static String client(String clientId) {
        return "client:" + clientId;
    }

    public static String clientRole(String clientId, String role) {
        return "client-role:" + clientId + "/" + role;
    }

    public static String user(String username) {
        return "user:" + username;
    }

    /** Natural key to id of the realm itself and of its realm roles, clients, client roles, users and groups. */
    public static Map<String, String> index(RawHttp http, String realm) {
        Map<String, String> ids = new TreeMap<>();
        String base = "/admin/realms/" + RawHttp.segment(realm);
        ids.put(REALM, get(http, base).path("id").asText());
        for (JsonNode r : get(http, base + "/roles?" + PAGE)) {
            ids.put(role(r.path("name").asText()), r.path("id").asText());
        }
        for (JsonNode c : get(http, base + "/clients?" + PAGE)) {
            String clientId = c.path("clientId").asText();
            ids.put(client(clientId), c.path("id").asText());
            for (JsonNode r : get(http, base + "/clients/" + RawHttp.segment(c.path("id").asText()) + "/roles?" + PAGE)) {
                ids.put(clientRole(clientId, r.path("name").asText()), r.path("id").asText());
            }
        }
        for (JsonNode u : get(http, base + "/users?briefRepresentation=true&" + PAGE)) {
            ids.put(user(u.path("username").asText()), u.path("id").asText());
        }
        groups(http, base, get(http, base + "/groups?briefRepresentation=true&" + PAGE), ids);
        return ids;
    }

    private static void groups(RawHttp http, String base, JsonNode groups, Map<String, String> ids) {
        for (JsonNode g : groups) {
            String id = g.path("id").asText();
            ids.put(group(g.path("path").asText()), id);
            if (g.path("subGroupCount").asInt(1) > 0) {
                String children = base + "/groups/" + RawHttp.segment(id) + "/children?briefRepresentation=true&" + PAGE;
                groups(http, base, get(http, children), ids);
            }
        }
    }

    private static JsonNode get(RawHttp http, String pathAndQuery) {
        return ServerCalls.get(http, pathAndQuery);
    }
}
