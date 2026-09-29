package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The dated allowlist of ways the typed admin client may read differently from the live server
 * ({@code admin-client-known-lag.json}). The adapter is built from keycloak/keycloak-client and trails HEAD: its
 * representations drop fields the server added and add defaults the server omits. Each entry pins one difference
 * of {@code JsonDiff.diff(raw, adapter)}: operation, path pattern and kind, with a reason and the date it was
 * first seen. Entries that match nothing in a full run are stale and must be removed once the adapter catches up.
 */
public final class KnownLag {

    public static final String RESOURCE = "/admin-client-known-lag.json";

    /**
     * @param key  {@code METHOD /named/{path}}
     * @param path {@link JsonDiff} path; {@code [*]} matches any index, {@code .*} any field
     * @param kind the difference, left being the server: {@code MISSING_RIGHT} is a field the adapter drops
     */
    public record Entry(String key, String path, JsonDiff.Kind kind, String reason, String evidence, String since) {
        String operationKey() {
            int space = key.indexOf(' ');
            return PathTemplates.operationKey(key.substring(0, space), key.substring(space + 1));
        }

        public String ref() {
            return "known-lag@" + since + ":" + kind + " " + path;
        }
    }

    /** Differences of one read, split into those an entry explains and those none does. */
    public record Assessment(Map<JsonDiff.Diff, Entry> documented, List<JsonDiff.Diff> undocumented) {
    }

    private record Rule(Entry entry, Pattern path) {
    }

    private final List<Rule> rules;
    private final Set<Entry> used = Collections.synchronizedSet(new HashSet<>());

    private KnownLag(List<Rule> rules) {
        this.rules = rules;
    }

    public static KnownLag load() {
        try (InputStream in = KnownLag.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESOURCE + " is not on the class path");
            }
            return parse(Json.MAPPER.readTree(in));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static KnownLag parse(JsonNode document) {
        List<Rule> rules = new ArrayList<>();
        for (JsonNode n : document.path("lag")) {
            String since = required(n, "since");
            LocalDate.parse(since);
            Entry e = new Entry(required(n, "key"), required(n, "path"), JsonDiff.Kind.valueOf(required(n, "kind")),
                    required(n, "reason"), required(n, "evidence"), since);
            rules.add(new Rule(e, JsonPaths.pattern(e.path())));
        }
        return new KnownLag(List.copyOf(rules));
    }

    public Assessment assess(String operationKey, List<JsonDiff.Diff> diffs) {
        Map<JsonDiff.Diff, Entry> documented = new LinkedHashMap<>();
        List<JsonDiff.Diff> undocumented = new ArrayList<>();
        for (JsonDiff.Diff d : diffs) {
            rules.stream()
                    .filter(r -> r.entry().operationKey().equals(operationKey) && r.entry().kind() == d.kind()
                            && r.path().matcher(d.path()).matches())
                    .findFirst()
                    .ifPresentOrElse(r -> {
                        documented.put(d, r.entry());
                        used.add(r.entry());
                    }, () -> undocumented.add(d));
        }
        return new Assessment(documented, List.copyOf(undocumented));
    }

    /** Entries that explained nothing so far; after a full run, stale ones. */
    public List<Entry> unused() {
        return rules.stream().map(Rule::entry).filter(e -> !used.contains(e)).toList();
    }

    /** An entry skeleton for an undocumented difference, ready to be completed and pasted into the file. */
    public static String skeleton(String namedKey, JsonDiff.Diff d) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("key", namedKey);
        e.put("path", d.path().replaceAll("\\[\\d+]", "[*]"));
        e.put("kind", d.kind().name());
        e.put("reason", "TODO why the adapter reads this differently");
        e.put("evidence", "TODO adapter representation class and server source file:line");
        e.put("since", LocalDate.now().toString());
        return Json.pretty(e);
    }

    private static String required(JsonNode n, String field) {
        String value = n.path(field).asText("").strip();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("Known-lag entry lacks '" + field + "': " + n);
        }
        return value;
    }
}
