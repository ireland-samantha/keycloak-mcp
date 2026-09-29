package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Predicate;

/**
 * The reasoned allowlist of disagreements between sources ({@code divergences.json}). An entry documents exactly
 * one observation: same operation, kind, sources and, unless the kind is {@code route}, the same observed values.
 * Entries that no longer match anything are stale and must be removed, so the file cannot silently outlive the
 * behaviour it explains.
 */
public final class DocumentedDivergences {

    public static final String RESOURCE = "/divergences.json";

    /**
     * @param key      {@code METHOD /named/{path}}
     * @param observed required except for {@code route}, where the server's answer may vary with enabled features
     * @param since    ISO date the divergence was first documented
     */
    public record Entry(String key, String kind, String sources, SortedMap<String, SortedSet<String>> observed,
                        String reason, String evidence, String since) {

        String operationKey() {
            int space = key.indexOf(' ');
            return PathTemplates.operationKey(key.substring(0, space), key.substring(space + 1));
        }

        boolean matches(Divergence d) {
            return operationKey().equals(d.key()) && kind.equals(d.kind()) && sources.equals(d.sources())
                    && (observed == null || observed.equals(d.observed()));
        }

        /** Short reference for ledgers and messages. */
        public String ref() {
            return kind + "@" + sources + ":" + key;
        }
    }

    /**
     * @param documented observation to the entry that explains it
     * @param stale      in-scope entries that matched no observation
     */
    public record Assessment(Map<Divergence, Entry> documented, List<Divergence> undocumented, List<Entry> stale) {
        public boolean clean() {
            return undocumented.isEmpty() && stale.isEmpty();
        }
    }

    private final List<Entry> entries;

    private DocumentedDivergences(List<Entry> entries) {
        this.entries = entries;
    }

    public static DocumentedDivergences load() {
        try (InputStream in = DocumentedDivergences.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESOURCE + " is not on the class path");
            }
            return parse(Json.MAPPER.readTree(in));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static DocumentedDivergences parse(JsonNode document) {
        List<Entry> entries = new ArrayList<>();
        Set<String> identities = new HashSet<>();
        for (JsonNode node : document.path("divergences")) {
            Entry e = entry(node);
            if (!identities.add(e.operationKey() + "|" + e.kind() + "|" + e.sources())) {
                throw new IllegalArgumentException("Duplicate divergence entry: " + e.ref());
            }
            entries.add(e);
        }
        return new DocumentedDivergences(List.copyOf(entries));
    }

    /**
     * Matches observations against the entries.
     *
     * @param scope which entries this check is responsible for; only those can be stale
     */
    public Assessment assess(Collection<Divergence> observations, Predicate<Entry> scope) {
        Map<Divergence, Entry> documented = new LinkedHashMap<>();
        List<Divergence> undocumented = new ArrayList<>();
        Set<Entry> used = new HashSet<>();
        for (Divergence d : observations) {
            entries.stream().filter(e -> e.matches(d)).findFirst().ifPresentOrElse(e -> {
                documented.put(d, e);
                used.add(e);
            }, () -> undocumented.add(d));
        }
        List<Entry> stale = entries.stream().filter(scope).filter(e -> !used.contains(e)).toList();
        return new Assessment(documented, List.copyOf(undocumented), stale);
    }

    /** An entry skeleton for an undocumented observation, ready to be completed and pasted into the file. */
    public static String skeleton(Divergence d) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("key", d.namedKey());
        e.put("kind", d.kind());
        e.put("sources", d.sources());
        e.put("observed", d.observed());
        e.put("reason", "TODO why the sources legitimately differ");
        e.put("evidence", "TODO server source file:line, adapter method, or observed response");
        e.put("since", LocalDate.now().toString());
        return Json.pretty(e);
    }

    private static Entry entry(JsonNode n) {
        String key = required(n, "key");
        if (!key.matches("[A-Z]+ /\\S*")) {
            throw new IllegalArgumentException("Divergence key must be 'METHOD /path': " + key);
        }
        String kind = required(n, "kind");
        String since = required(n, "since");
        try {
            LocalDate.parse(since);
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("Divergence " + key + ": since must be an ISO date: " + since, e);
        }
        SortedMap<String, SortedSet<String>> observed = null;
        if (n.has("observed")) {
            observed = new TreeMap<>();
            for (Map.Entry<String, JsonNode> side : n.path("observed").properties()) {
                observed.put(side.getKey(), new TreeSet<>(Json.texts(side.getValue())));
            }
        } else if (!kind.equals("route")) {
            throw new IllegalArgumentException("Divergence " + key + " (" + kind + ") must pin what was observed");
        }
        return new Entry(key, kind, required(n, "sources"), observed, required(n, "reason"), required(n, "evidence"), since);
    }

    private static String required(JsonNode n, String field) {
        String value = n.path(field).asText("").strip();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("Divergence entry lacks '" + field + "': " + n);
        }
        return value;
    }
}
