package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The reasoned list of values that legitimately differ between two identical reads ({@code read-volatility.json}):
 * clocks, memory gauges, per-request token ids. Before two answers are compared, every documented value is
 * replaced by {@link #MASK} on both sides; its presence is still compared. Anything else that differs between two
 * identical raw reads is undocumented volatility and fails the read.
 */
public final class Volatility {

    public static final String RESOURCE = "/read-volatility.json";
    public static final String MASK = "<volatile>";

    /**
     * @param key     {@code METHOD /named/{path}}
     * @param path    JSON path as {@link JsonDiff} prints it; {@code [*]} matches any index, {@code .*} any field
     * @param pattern when set, only the matches of this regex inside the string value are masked
     */
    public record Entry(String key, String path, String pattern, String reason, String evidence) {
        String operationKey() {
            int space = key.indexOf(' ');
            return PathTemplates.operationKey(key.substring(0, space), key.substring(space + 1));
        }
    }

    private record Rule(Entry entry, Pattern path, Pattern pattern) {
    }

    private final List<Rule> rules;
    private final Set<Entry> used = Collections.synchronizedSet(new HashSet<>());

    private Volatility(List<Rule> rules) {
        this.rules = rules;
    }

    public static Volatility load() {
        try (InputStream in = Volatility.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESOURCE + " is not on the class path");
            }
            return parse(Json.MAPPER.readTree(in));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static Volatility parse(JsonNode document) {
        List<Rule> rules = new ArrayList<>();
        for (JsonNode n : document.path("volatile")) {
            Entry e = new Entry(required(n, "key"), required(n, "path"), n.path("pattern").asText(null),
                    required(n, "reason"), required(n, "evidence"));
            rules.add(new Rule(e, JsonPaths.pattern(e.path()), e.pattern() == null ? null : Pattern.compile(e.pattern())));
        }
        return new Volatility(List.copyOf(rules));
    }

    /** {@code value} with every documented volatile value of {@code operationKey} masked. */
    public JsonNode mask(String operationKey, JsonNode value) {
        List<Rule> applicable = rules.stream().filter(r -> r.entry().operationKey().equals(operationKey)).toList();
        return applicable.isEmpty() || value == null ? value : mask("$", value.deepCopy(), applicable);
    }

    /** Entries that never masked anything so far; after a full run, stale ones. */
    public List<Entry> unused() {
        return rules.stream().map(Rule::entry).filter(e -> !used.contains(e)).toList();
    }

    private JsonNode mask(String path, JsonNode node, List<Rule> applicable) {
        for (Rule r : applicable) {
            if (r.path().matcher(path).matches()) {
                used.add(r.entry());
                if (r.pattern() == null) {
                    return new TextNode(MASK);
                }
                if (node.isTextual()) {
                    node = new TextNode(r.pattern().matcher(node.asText()).replaceAll(MASK));
                }
            }
        }
        if (node instanceof ObjectNode object) {
            for (Map.Entry<String, JsonNode> field : object.properties()) {
                field.setValue(mask(path + "." + field.getKey(), field.getValue(), applicable));
            }
        } else if (node instanceof ArrayNode array) {
            for (int i = 0; i < array.size(); i++) {
                array.set(i, mask(path + "[" + i + "]", array.get(i), applicable));
            }
        }
        return node;
    }

    private static String required(JsonNode n, String field) {
        String value = n.path(field).asText("").strip();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("Volatility entry lacks '" + field + "': " + n);
        }
        return value;
    }
}
