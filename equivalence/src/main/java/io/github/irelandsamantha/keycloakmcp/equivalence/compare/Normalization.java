package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Makes the state of two realms comparable although the server generated different ids in each: every string that
 * is the id of a known entity becomes {@code <natural key>}, the realm's name inside any string becomes
 * {@value #REALM}, and documented volatile values become {@link Volatility#MASK}. Object keys are rewritten the same
 * way. Nothing else changes, so any other difference between two normalized answers is a difference in state.
 */
public final class Normalization {

    public static final String REALM = "<realm>";

    private final String realmName;
    private final Map<String, String> labelsById = new HashMap<>();
    private final List<Pattern> volatilePaths;

    /**
     * @param naturalKeys   natural key to id of every entity whose id may appear
     * @param volatilePaths paths as {@link JsonDiff} prints them; {@code [*]} matches any index, {@code .*} any field
     */
    public Normalization(String realmName, Map<String, String> naturalKeys, List<String> volatilePaths) {
        this.realmName = realmName;
        naturalKeys.forEach((key, id) -> labelsById.put(id, "<" + key.replace(realmName, REALM) + ">"));
        this.volatilePaths = volatilePaths.stream().map(JsonPaths::pattern).toList();
    }

    public JsonNode apply(JsonNode value) {
        return value == null ? null : normalize("$", value);
    }

    private JsonNode normalize(String path, JsonNode node) {
        if (volatilePaths.stream().anyMatch(p -> p.matcher(path).matches())) {
            return new TextNode(Volatility.MASK);
        }
        if (node.isTextual()) {
            return new TextNode(text(node.asText()));
        }
        if (node.isObject()) {
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            node.properties().forEach(field ->
                    out.set(text(field.getKey()), normalize(path + "." + field.getKey(), field.getValue())));
            return out;
        }
        if (node.isArray()) {
            ArrayNode out = JsonNodeFactory.instance.arrayNode();
            for (int i = 0; i < node.size(); i++) {
                out.add(normalize(path + "[" + i + "]", node.get(i)));
            }
            return out;
        }
        return node;
    }

    private String text(String value) {
        String label = labelsById.get(value);
        return label != null ? label : value.replace(realmName, REALM);
    }
}
